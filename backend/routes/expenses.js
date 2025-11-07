// NOTE: There are no references to 'old_data' in this file. If you still get an 'Unknown column old_data' error, check other backend files, triggers, or restart your backend server.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const db = require('../config/db');
const auth = require('../middleware/auth');
const fs = require('fs');
const { parse } = require('csv-parse');
const EmailService = require('../services/emailService');
const { getExpenseStatusEmailTemplate, getExpenseSubmissionTemplate } = require('../utils/emailTemplates');
const xlsx = require('xlsx'); // Add at top
const { getExpenseResubmissionTemplate } = require('../utils/emailTemplates'); // Add at the top
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET
});
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    let folder = 'receipts';
    if (file.mimetype === 'application/pdf') folder = 'pdfs';
    return {
      folder,
      allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
      public_id: Date.now() + '-' + file.originalname.replace(/\s+/g, '_')
    };
  }
});
const upload = multer({ storage });

// Add at the top with other constants
const EXPENSE_STATUS = {
  PENDING: 'pending',
  COORDINATOR_APPROVED: 'coordinator_approved',
  COORDINATOR_REJECTED: 'coordinator_rejected',
  HR_APPROVED: 'hr_approved',
  HR_REJECTED: 'hr_rejected',
  ACCOUNTS_APPROVED: 'accounts_approved',
  ACCOUNTS_REJECTED: 'accounts_rejected'
};

// Replace existing ALLOWANCE_SCOPES constant
const ALLOWANCE_SCOPES = {
  DAILY_METRO: 'Daily Allowance Metro',
  DAILY_NON_METRO: 'Daily Allowance Non-Metro',
  SITE_FIXED: 'Site Allowance'
};

// Add this helper function
function getCriticalTabsForRole(role) {
  if (role === 'user') return ['new_expense', 'expense_list'];
  if (role === 'admin' || role === 'hr') return ['expense_list'];
  if (role === 'accounts' || role === 'coordinator') return ['expense_list'];
  return [];
}

// Add this helper function near the top with other helpers
const validateGeneralProject = (formData) => {
  if (formData.project_code?.toLowerCase() === 'general') {
    if (!formData.site_location || typeof formData.site_location !== 'string') {
      throw new Error('Site location is required for general project');
    }
    if (!formData.site_location.trim()) {
      throw new Error('Site location cannot be empty for general project');
    }
    if (!formData.site_incharge_emp_code || typeof formData.site_incharge_emp_code !== 'string') {
      throw new Error('Site incharge employee code is required for general project');
    }
    if (!formData.site_incharge_emp_code.trim()) {
      throw new Error('Site incharge employee code cannot be empty for general project');
    }
  }
};

// Add this helper at the top of the file
function toMysqlDate(val) {
  if (!val) return null;
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  // If it's a string with time (e.g., 2025-09-08T18:30:00.000Z), parse as local
  const d = new Date(val);
  if (!isNaN(d)) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return null;
}

// Get current employee details
router.get('/employees/current', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT e.*, d.department_name, des.designation_name, u.tab_permissions
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.department_id
       LEFT JOIN designations des ON e.designation_id = des.designation_id
       LEFT JOIN users u ON e.emp_id = u.emp_id
       WHERE e.emp_id = ?`,
      [req.user.emp_id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const user = rows[0];
    // Parse tab_permissions if present
    let tabPermissions = [];
    if (user.tab_permissions) {
      try {
        tabPermissions = JSON.parse(user.tab_permissions);
      } catch {
        tabPermissions = Array.isArray(user.tab_permissions) ? user.tab_permissions : [];
      }
    }
    user.tab_permissions = tabPermissions;
    // Do NOT force critical tabs, only return those in tab_permissions
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Search projects by code
// Get all expenses based on role
router.get('/', auth, async (req, res) => {
  try {
    // Get travel data for each expense
    let query = `
      SELECT ef.*, e.first_name, e.middle_name, e.last_name, e.emp_code,
      d.department_id, d.department_name, des.designation_name,
      p.project_name, p.project_code,
      ANY_VALUE(ep.site_location) AS expense_site_location,
      ANY_VALUE(ep.site_incharge_emp_code) AS expense_site_incharge_emp_code,
      ANY_VALUE(p.site_location) AS project_site_location,
      ANY_VALUE(p.site_incharge_emp_code) AS project_site_incharge_emp_code,
      ANY_VALUE(CONCAT(coordinator.first_name, ' ', coordinator.last_name)) as coordinator_name,
      ANY_VALUE(CONCAT(hr.first_name, ' ', hr.last_name)) as hr_name,
      ANY_VALUE(CONCAT(accounts.first_name, ' ', accounts.last_name)) as accounts_name,
      GROUP_CONCAT(
        JSON_OBJECT(
          'travel_date', DATE_FORMAT(td.travel_date, '%Y-%m-%d'),
          'from_location', td.from_location,
          'to_location', td.to_location,
          'mode_of_transport', td.mode_of_transport,
          'fare_amount', td.fare_amount
        )
      ) as travel_data
      FROM expense_form ef
      JOIN employees e ON ef.emp_id = e.emp_id
      LEFT JOIN departments d ON e.department_id = d.department_id
      LEFT JOIN designations des ON e.designation_id = des.designation_id
      LEFT JOIN projects p ON ef.project_id = p.project_id
      LEFT JOIN expense_projects ep ON ef.expense_id = ep.expense_id
      LEFT JOIN employees coordinator ON ef.coordinator_reviewed_by = coordinator.emp_id
      LEFT JOIN employees hr ON ef.hr_reviewed_by = hr.emp_id
      LEFT JOIN employees accounts ON ef.accounts_reviewed_by = accounts.emp_id
      LEFT JOIN travel_data td ON ef.expense_id = td.expense_id
    `;

    let whereClause = '';
    const params = [];

    switch (req.user.role) {
      case 'admin':
        break;
      case 'coordinator':
        // Show expenses for departments assigned to this coordinator in coordinator_departments
        const [assignedDepartments] = await db.query(
          'SELECT department_id FROM coordinator_departments WHERE coordinator_emp_id = ?',
          [req.user.emp_id]
        );
        const deptIds = assignedDepartments.map(row => row.department_id);
        if (deptIds.length > 0) {
          whereClause = ` WHERE e.department_id IN (${deptIds.map(() => '?').join(',')}) OR ef.emp_id = ?`;
          params.push(...deptIds, req.user.emp_id);
        } else {
          // If no departments assigned, only show own expenses
          whereClause = ' WHERE ef.emp_id = ?';
          params.push(req.user.emp_id);
        }
        break;
      case 'hr':
        whereClause = ' WHERE (ef.coordinator_reviewed_by IS NOT NULL OR ef.emp_id = ?)';
        params.push(req.user.emp_id);
        break;
      case 'accounts':
        whereClause = ' WHERE (ef.hr_reviewed_by IS NOT NULL OR ef.emp_id = ?)';
        params.push(req.user.emp_id);
        break;
      case 'user':
      default:
        whereClause = ' WHERE ef.emp_id = ?';
        params.push(req.user.emp_id);
    }

    query += whereClause + ' GROUP BY ef.expense_id ORDER BY ef.created_at DESC';

    const [expenses] = await db.query(query, params);

    // After fetching expenses, add coordinator info from coordinator_departments
    for (const exp of expenses) {
      // Get all coordinators for this expense's department
      const [coordinatorRows] = await db.query(
        `SELECT e.emp_id, e.first_name, e.last_name, e.email
         FROM coordinator_departments cd
         JOIN employees e ON cd.coordinator_emp_id = e.emp_id
         WHERE cd.department_id = ?`,
        [exp.department_id]
      );
      exp.coordinators = coordinatorRows.map(c => ({
        emp_id: c.emp_id,
        name: `${c.first_name} ${c.last_name}`,
        email: c.email
      }));

      // Fetch allowance entries for each expense
      const [journeyAllowance] = await db.query(
        `SELECT id, expense_id, emp_id, from_date, to_date, scope, no_of_days, amount FROM journey_allowance WHERE expense_id = ?`, [exp.expense_id]
      );
      const [returnAllowance] = await db.query(
        `SELECT id, expense_id, emp_id, from_date, to_date, scope, no_of_days, amount FROM return_allowance WHERE expense_id = ?`, [exp.expense_id]
      );
      const [stayAllowance] = await db.query(
        `SELECT id, expense_id, emp_id, from_date, to_date, scope, no_of_days, amount FROM stay_allowance WHERE expense_id = ?`, [exp.expense_id]
      );
      exp.journey_allowance = journeyAllowance;
      exp.return_allowance = returnAllowance;
      exp.stay_allowance = stayAllowance;

      // Fetch hotel_expenses for each expense
      const [hotelExpenses] = await db.query(
        `SELECT * FROM hotel_expenses WHERE expense_id = ?`, [exp.expense_id]
      );
      exp.hotel_expenses = hotelExpenses;

      // Fetch food_expenses for each expense
      const [foodExpenses] = await db.query(
        `SELECT * FROM food_expenses WHERE expense_id = ?`, [exp.expense_id]
      );
      exp.food_expenses = foodExpenses;

      // Fetch receipt paths for each expense
      const [receiptRows] = await db.query(
        `SELECT travel_receipt_path, food_receipt_path, hotel_receipt_path, special_approval_path FROM expense_form WHERE expense_id = ?`, [exp.expense_id]
      );
      if (receiptRows && receiptRows[0]) {
        exp.travel_receipt_path = receiptRows[0].travel_receipt_path;
        exp.food_receipt_path = receiptRows[0].food_receipt_path;
        exp.hotel_receipt_path = receiptRows[0].hotel_receipt_path;
        exp.special_approval_path = receiptRows[0].special_approval_path;
      }
    }

    const mappedExpenses = expenses.map(exp => ({
      ...exp,
      department_id: exp.department_id,
      employee_name: (exp.first_name || exp.middle_name || exp.last_name)
        ? `${exp.first_name || ''}${exp.middle_name ? ' ' + exp.middle_name : ''}${exp.last_name ? ' ' + exp.last_name : ''}`.replace(/\s+/g, ' ').trim()
        : exp.employee_name,
      first_name: exp.first_name,
      middle_name: exp.middle_name,
      last_name: exp.last_name,
      // Ensure travel_data is parsed as array of objects
      travel_data: exp.travel_data ? JSON.parse(`[${exp.travel_data}]`) : [],
      site_location: exp.expense_site_location || exp.project_site_location || null,
      site_incharge_emp_code: exp.expense_site_incharge_emp_code || exp.project_site_incharge_emp_code || null,
      journey_allowance: exp.journey_allowance,
      return_allowance: exp.return_allowance,
      stay_allowance: exp.stay_allowance,
      review_history: [
        exp.coordinator_reviewed_at && {
          role: 'Coordinator',
          reviewer: exp.coordinator_name,
          comment: exp.coordinator_comment,
          status: exp.status.startsWith('coordinator_') ? exp.status.replace('coordinator_', '') : null,
          timestamp: exp.coordinator_reviewed_at
        },
        exp.hr_reviewed_at && {
          role: 'HR',
          reviewer: exp.hr_name,
          comment: exp.hr_comment,
          status: exp.status.startsWith('hr_') ? exp.status.replace('hr_', '') : null,
          timestamp: exp.hr_reviewed_at
        },
        exp.accounts_reviewed_at && {
          role: 'Accounts',
          reviewer: exp.accounts_name,
          comment: exp.accounts_comment,
          status: exp.status.startsWith('accounts_') ? exp.status.replace('accounts_', '') : null,
          timestamp: exp.accounts_reviewed_at
        }
      ].filter(Boolean)
    }));

    res.json(mappedExpenses);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user's own expenses
router.get('/my', auth, async (req, res) => {
  try {
    const [expenses] = await db.query(
      `SELECT ef.*, e.first_name, e.last_name, e.emp_code,
       d.department_name, des.designation_name,
       p.project_name, p.project_code
       FROM expense_form ef
       JOIN employees e ON ef.emp_id = e.emp_id
       LEFT JOIN departments d ON e.department_id = d.department_id
       LEFT JOIN designations des ON e.designation_id = des.designation_id
       JOIN projects p ON ef.project_id = p.project_id
       WHERE ef.emp_id = ?
       ORDER BY ef.created_at DESC`,
      [req.user.emp_id]
    );

    res.json(expenses.map(exp => ({
      ...exp,
      employee_name: `${exp.first_name} ${exp.last_name}`
     })));
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get expenses pending coordinator review
router.get('/pending-coordinator', auth, async (req, res) => {
  try {
    if (req.user.role !== 'coordinator') {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    const [expenses] = await db.query(
      `SELECT ef.*, e.first_name, e.last_name, e.emp_code,
       d.department_name, des.designation_name,
       p.project_name, p.project_code
       FROM expense_form ef
       JOIN employees e ON ef.emp_id = e.emp_id
       LEFT JOIN departments d ON e.department_id = d.department_id
       LEFT JOIN designations des ON e.designation_id = des.designation_id
       JOIN projects p ON ef.project_id = p.project_id
       WHERE ef.status = 'pending'
       ORDER BY ef.created_at DESC`
    );

    res.json(expenses.map(exp => ({
      ...exp,
      employee_name: `${exp.first_name} ${exp.last_name}`
    })));
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get expenses pending HR review
router.get('/pending-hr', auth, async (req, res) => {
  try {
    if (req.user.role !== 'hr') {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    const [expenses] = await db.query(
      `SELECT ef.*, e.first_name, e.last_name, e.emp_code,
       d.department_name, des.designation_name,
       p.project_name, p.project_code
       FROM expense_form ef
       JOIN employees e ON ef.emp_id = e.emp_id
       LEFT JOIN departments d ON e.department_id = d.department_id
       LEFT JOIN designations des ON e.designation_id = des.designation_id
       JOIN projects p ON ef.project_id = p.project_id
       WHERE ef.status = 'coordinator_approved'
       ORDER BY ef.created_at DESC`
    );

    res.json(expenses.map(exp => ({
      ...exp,
      employee_name: `${exp.first_name} ${exp.last_name}`
    })));
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get expenses pending accounts review
router.get('/pending-accounts', auth, async (req, res) => {
  try {
    if (req.user.role !== 'accounts') {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    const [expenses] = await db.query(
      `SELECT ef.*, e.first_name, e.last_name, e.emp_code,
       d.department_name, des.designation_name,
       p.project_name, p.project_code
       FROM expense_form ef
       JOIN employees e ON ef.emp_id = e.emp_id
       LEFT JOIN departments d ON e.department_id = d.department_id
       LEFT JOIN designations des ON e.designation_id = des.designation_id
       JOIN projects p ON ef.project_id = p.project_id
       WHERE ef.status = 'hr_approved'
       ORDER BY ef.created_at DESC`
    );

    res.json(expenses.map(exp => ({
      ...exp,
      employee_name: `${exp.first_name} ${exp.last_name}`
    })));
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Update expense status
router.post('/:expenseId/status', auth, async (req, res) => {
  try {
    const { expenseId } = req.params;
    const { status, comment } = req.body;

    // Validate status based on role
    const validStatus = {
      coordinator: ['coordinator_approved', 'coordinator_rejected'],
      hr: ['hr_approved', 'hr_rejected'],
      accounts: ['accounts_approved', 'accounts_rejected'],
      admin: ['coordinator_approved', 'coordinator_rejected', 'hr_approved', 'hr_rejected', 'accounts_approved', 'accounts_rejected']
    };

    if (!validStatus[req.user.role]?.includes(status)) {
      return res.status(400).json({ message: 'Invalid status for your role' });
    }

    await db.query(
      `UPDATE expense_form SET 
       status = ?,
       ${req.user.role}_comment = ?,
       ${req.user.role}_reviewed_by = ?,
       ${req.user.role}_reviewed_at = NOW()
       WHERE expense_id = ?`,
      [status, comment, req.user.emp_id, expenseId]
    );

    // Fetch full expense and employee details for email
    const [expenseRows] = await db.query(
      `SELECT ef.*, e.first_name, e.middle_name, e.last_name, e.emp_code, e.email as employeeEmail,
        d.department_name, des.designation_name,
        p.project_name, p.project_code, p.site_location,
        ANY_VALUE(ep.site_location) AS expense_site_location,
        ANY_VALUE(ep.site_incharge_emp_code) AS expense_site_incharge_emp_code
      FROM expense_form ef
      JOIN employees e ON ef.emp_id = e.emp_id
      LEFT JOIN departments d ON e.department_id = d.department_id
      LEFT JOIN designations des ON e.designation_id = des.designation_id
      LEFT JOIN projects p ON ef.project_id = p.project_id
      LEFT JOIN expense_projects ep ON ef.expense_id = ep.expense_id
      WHERE ef.expense_id = ?
      GROUP BY ef.expense_id`,
      [expenseId]
    );
    const expense = expenseRows[0];

    // Recalculate totals for email (always fetch latest from child tables)
    const [travelRows] = await db.query(
      `SELECT fare_amount FROM travel_data WHERE expense_id = ?`, [expenseId]
    );
    const travelFareTotal = travelRows.reduce((sum, t) => sum + (parseFloat(t.fare_amount) || 0), 0);
    const [journeyRows] = await db.query(
      `SELECT amount, no_of_days FROM journey_allowance WHERE expense_id = ?`, [expenseId]
    );
    const [returnRows] = await db.query(
      `SELECT amount, no_of_days FROM return_allowance WHERE expense_id = ?`, [expenseId]
    );
    const [stayRows] = await db.query(
      `SELECT amount, no_of_days FROM stay_allowance WHERE expense_id = ?`, [expenseId]
    );
    const daAllowanceTotal = [...journeyRows, ...returnRows, ...stayRows].reduce((sum, row) => sum + ((parseFloat(row.amount) || 0) * (parseInt(row.no_of_days, 10) || 0)), 0);
    const [hotelRows] = await db.query(
      `SELECT bill_amount FROM hotel_expenses WHERE expense_id = ?`, [expenseId]
    );
    const hotelExpenseTotal = hotelRows.reduce((sum, h) => sum + (parseFloat(h.bill_amount) || 0), 0);
    const [foodRows] = await db.query(
      `SELECT bill_amount FROM food_expenses WHERE expense_id = ?`, [expenseId]
    );
    const foodExpenseTotal = foodRows.reduce((sum, f) => sum + (parseFloat(f.bill_amount) || 0), 0);
    const claimAmount = travelFareTotal + daAllowanceTotal + foodExpenseTotal + hotelExpenseTotal;

    // Compose full employee name
    const employeeFullName = (expense.first_name || expense.middle_name || expense.last_name)
      ? `${expense.first_name || ''}${expense.middle_name ? ' ' + expense.middle_name : ''}${expense.last_name ? ' ' + expense.last_name : ''}`.replace(/\s+/g, ' ').trim()
      : (expense.employee_name || '');

    try {
      // Send mail to submitter only once, from approver's email, with correct template and actual data
      await EmailService.sendEmail(
        expense.employeeEmail,
        `Expense Status Update: ${status}`,
        getExpenseStatusEmailTemplate({
          recipientName: employeeFullName,
          status,
          previousStatus: expense.status,
          reviewerName: req.user.name || req.user.username || '',
          employeeFirstName: expense.first_name || '',
          employeeMiddleName: expense.middle_name || '',
          employeeLastName: expense.last_name || '',
          employeeName: employeeFullName,
          employeeCode: expense.emp_code || '',
          department: expense.department_name || '',
          designation: expense.designation_name || expense.designation || '',
          projectCode: expense.project_code || '',
          projectName: expense.project_name || '',
          siteLocation: expense.expense_site_location || expense.site_location || expense.project_site_location || '',
          daAllowanceTotal: daAllowanceTotal > 0 ? daAllowanceTotal : '',
          travelFareTotal: travelFareTotal > 0 ? travelFareTotal : '',
          foodExpenseTotal: foodExpenseTotal > 0 ? foodExpenseTotal : '',
          hotelExpenseTotal: hotelExpenseTotal > 0 ? hotelExpenseTotal : '',
          claimAmount: claimAmount > 0 ? claimAmount : '',
          requiresAction: false,
          comment: comment || ''
        }),
        req.user.email || '',
        req.user.name || req.user.username || ''
      );
      // Send mail to next reviewer (HR, Accounts) from default mail id, with correct template and actual data
      if (status === 'coordinator_approved') {
        const [hrUsers] = await db.query(
          `SELECT DISTINCT e.email, CONCAT(e.first_name, ' ', e.last_name) as name
           FROM employees e
           JOIN users u ON e.emp_id = u.emp_id
           WHERE u.role = 'hr' AND e.email IS NOT NULL`
        );
        for (const hr of hrUsers) {
          await EmailService.sendEmail(
            hr.email,
            'Expense Review Required',
            getExpenseStatusEmailTemplate({
              recipientName: hr.name,
              status,
              previousStatus: expense.status,
              reviewerName: req.user.name || req.user.username || '',
              employeeFirstName: expense.first_name || '',
              employeeMiddleName: expense.middle_name || '',
              employeeLastName: expense.last_name || '',
              employeeName: employeeFullName,
              employeeCode: expense.emp_code || '',
              department: expense.department_name || '',
              designation: expense.designation_name || expense.designation || '',
              projectCode: expense.project_code || '',
              projectName: expense.project_name || '',
              siteLocation: expense.expense_site_location || expense.site_location || expense.project_site_location || '',
              daAllowanceTotal: daAllowanceTotal > 0 ? daAllowanceTotal : '',
              travelFareTotal: travelFareTotal > 0 ? travelFareTotal : '',
              foodExpenseTotal: foodExpenseTotal > 0 ? foodExpenseTotal : '',
              hotelExpenseTotal: hotelExpenseTotal > 0 ? hotelExpenseTotal : '',
              claimAmount: claimAmount > 0 ? claimAmount : '',
              requiresAction: true,
              comment: comment || ''
            }),
            process.env.EMAIL_USER,
            process.env.EMAIL_FROM_NAME
          );
        }
      }
      if (status === 'hr_approved') {
        const [accountsUsers] = await db.query(
          `SELECT DISTINCT e.email, CONCAT(e.first_name, ' ', e.last_name) as name
           FROM employees e
           JOIN users u ON e.emp_id = u.emp_id
           WHERE u.role = 'accounts' AND e.email IS NOT NULL`
        );
        for (const acc of accountsUsers) {
          await EmailService.sendEmail(
            acc.email,
            'Expense Review Required',
            getExpenseStatusEmailTemplate({
              recipientName: acc.name,
              status,
              previousStatus: expense.status,
              reviewerName: req.user.name || req.user.username || '',
              employeeFirstName: expense.first_name || '',
              employeeMiddleName: expense.middle_name || '',
              employeeLastName: expense.last_name || '',
              employeeName: employeeFullName,
              employeeCode: expense.emp_code || '',
              department: expense.department_name || '',
              designation: expense.designation_name || expense.designation || '',
              projectCode: expense.project_code || '',
              projectName: expense.project_name || '',
              siteLocation: expense.expense_site_location || expense.site_location || expense.project_site_location || '',
              daAllowanceTotal: daAllowanceTotal > 0 ? daAllowanceTotal : '',
              travelFareTotal: travelFareTotal > 0 ? travelFareTotal : '',
              foodExpenseTotal: foodExpenseTotal > 0 ? foodExpenseTotal : '',
              hotelExpenseTotal: hotelExpenseTotal > 0 ? hotelExpenseTotal : '',
              claimAmount: claimAmount > 0 ? claimAmount : '',
              requiresAction: true,
              comment: comment || ''
            }),
            process.env.EMAIL_USER,
            process.env.EMAIL_FROM_NAME
          );
        }
      }
      // If rejected, notify submitter from approver's mail id, with correct data
      if (status.endsWith('_rejected')) {
        await EmailService.sendEmail(
          expense.employeeEmail,
          `Expense Status Update: ${status}`,
          getExpenseStatusEmailTemplate({
            recipientName: employeeFullName,
            status,
            previousStatus: expense.status,
            reviewerName: req.user.name || req.user.username || '',
            employeeFirstName: expense.first_name || '',
            employeeMiddleName: expense.middle_name || '',
            employeeLastName: expense.last_name || '',
            employeeName: employeeFullName,
            employeeCode: expense.emp_code || '',
            department: expense.department_name || '',
            designation: expense.designation_name || expense.designation || '',
            projectCode: expense.project_code || '',
            projectName: expense.project_name || '',
            siteLocation: expense.expense_site_location || expense.site_location || expense.project_site_location || '',
            daAllowanceTotal: daAllowanceTotal > 0 ? daAllowanceTotal : '',
            travelFareTotal: travelFareTotal > 0 ? travelFareTotal : '',
            foodExpenseTotal: foodExpenseTotal > 0 ? foodExpenseTotal : '',
            hotelExpenseTotal: hotelExpenseTotal > 0 ? hotelExpenseTotal : '',
            claimAmount: claimAmount > 0 ? claimAmount : '',
            requiresAction: false,
            comment: comment || ''
          }),
          req.user.email || '',
          req.user.name || req.user.username || ''
        );
      }
    } catch (emailError) {
    }

    res.json({ message: 'Status updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Modify the project search endpoint
router.get('/projects/search', auth, async (req, res) => {
  try {
    const { code } = req.query;
    const [projects] = await db.query(
      `SELECT p.project_id, p.project_code, p.project_name,
              CASE 
                WHEN p.project_code = 'general' THEN NULL 
                ELSE p.site_location 
              END as site_location,
              CASE 
                WHEN p.project_code = 'general' THEN NULL 
                ELSE p.site_incharge_emp_code 
              END as site_incharge_emp_code
       FROM projects p 
       WHERE p.project_code = ?`,
      [code]
    );
    res.json(projects);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all projects
router.get('/projects', auth, async (req, res) => {
  try {
    const [projects] = await db.query(
      'SELECT project_id, project_code, project_name FROM projects'
    );
    res.json(projects);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all projects with all fields (for frontend dropdowns, etc.)
router.get('/projects/all-fields', auth, async (req, res) => {
  try {
    const [projects] = await db.query(
      'SELECT project_id, project_code, project_name, site_location, site_incharge_emp_code FROM projects'
    );
    res.json(projects);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Update the project update endpoint
router.put('/projects/:projectId', auth, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Allow both admin and hr to update projects
    if (req.user.role !== 'admin' && req.user.role !== 'hr') {
      throw new Error('Only admin or HR can update projects');
    }

    const { project_name, project_code, site_location, site_incharge_emp_code } = req.body;
    const projectId = req.params.projectId;
    
    if (!project_code || !project_name) {
      throw new Error('Project code and name are required');
    }

    // Check if the new project code already exists for different project
    const [existingProject] = await connection.query(
      'SELECT project_id FROM projects WHERE project_code = ? AND project_id != ?',
      [project_code, projectId]
    );

    if (existingProject.length > 0) {
      throw new Error('Project code already exists');
    }

    // Update the project (include site_location and site_incharge_emp_code)
    await connection.query(
      'UPDATE projects SET project_name = ?, project_code = ?, site_location = ?, site_incharge_emp_code = ? WHERE project_id = ?',
      [project_name, project_code, site_location || null, site_incharge_emp_code || null, projectId]
    );

    // Get updated project details
    const [updatedProject] = await connection.query(
      'SELECT project_id, project_code, project_name, site_location, site_incharge_emp_code FROM projects WHERE project_id = ?',
      [projectId]
    );

    await connection.commit();
    res.json({
      message: 'Project updated successfully',
      project: updatedProject[0]
    });

  } catch (error) {
    await connection.rollback();
    res.status(400).json({ 
      message: error.message || 'Failed to update project'
    });
  } finally {
    connection.release();
  }
});

// Add new project
router.post('/projects', auth, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Allow both admin and hr to add projects
    if (req.user.role !== 'admin' && req.user.role !== 'hr') {
      throw new Error('Only admin or HR can add projects');
    }

    const { project_code, project_name, site_location, site_incharge_emp_code } = req.body;

    if (!project_code || !project_name) {
      throw new Error('Project code and name are required');
    }

    // Check if project code already exists
    const [existingProject] = await connection.query(
      'SELECT * FROM projects WHERE project_code = ?',
      [project_code]
    );

    if (existingProject.length > 0) {
      throw new Error('Project code already exists');
    }

    // Insert new project (include site_location and site_incharge_emp_code)
    const [result] = await connection.query(
      'INSERT INTO projects (project_code, project_name, site_location, site_incharge_emp_code) VALUES (?, ?, ?, ?)',
      [project_code, project_name, site_location || null, site_incharge_emp_code || null]
    );

    // Get the newly created project
    const [newProject] = await connection.query(
      'SELECT project_id, project_code, project_name, site_location, site_incharge_emp_code FROM projects WHERE project_id = ?',
      [result.insertId]
    );

    await connection.commit();
    res.status(201).json(newProject[0]);

  } catch (error) {
    await connection.rollback();
    res.status(error.message.includes('Only admin') ? 403 : 400).json({ 
      message: error.message || 'Server error while adding project'
    });
  } finally {
    connection.release();
  }
});

// Modify the delete project endpoint
router.delete('/projects/:projectId', auth, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Allow both admin and hr to delete projects
    if (req.user.role !== 'admin' && req.user.role !== 'hr') {
      throw new Error('Only admin or HR can delete projects');
    }

    const projectId = req.params.projectId;
    if (!projectId) {
      throw new Error('Project ID is required');
    }

    // Check if project exists
    const [project] = await connection.query(
      'SELECT * FROM projects WHERE project_id = ?',
      [projectId]
    );

    if (!project.length) {
      throw new Error('Project not found');
    }

    // Check if project is used in expenses
    const [expenses] = await connection.query(
      'SELECT COUNT(*) as count FROM expense_form WHERE project_id = ?',
      [projectId]
    );

    if (expenses[0].count > 0) {
      throw new Error('Cannot delete project as it is being used in expense forms');
    }

    // Delete the project
    await connection.query(
      'DELETE FROM projects WHERE project_id = ?',
      [projectId]
    );

    await connection.commit();
    res.json({ 
      message: 'Project deleted successfully',
      projectId
    });

  } catch (error) {
    await connection.rollback();
    res.status(error.message.includes('Only admin') ? 403 : 400).json({ 
      message: error.message
    });
  } finally {
    connection.release();
  }
});

// Submit expense form
router.post('/', auth, upload.fields([
  { name: 'travelReceipt', maxCount: 1 },
  { name: 'specialApproval', maxCount: 1 },
  { name: 'hotelReceipt', maxCount: 1 },
  { name: 'foodReceipt', maxCount: 1 }
]), async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const formData = JSON.parse(req.body.data);
    
    // Validate general project data before proceeding
    validateGeneralProject(formData);

    // Get project details
    const [projectResult] = await connection.query(
      `SELECT project_id FROM projects WHERE project_code = ?`,
      [formData.project_code]
    );

    if (!projectResult.length) {
      throw new Error('Project not found');
    }

    const projectId = projectResult[0].project_id;

    // --- SAFETY: Recalculate claim_amount on backend ---
    const totalTravel = Array.isArray(formData.travel_data)
      ? formData.travel_data.reduce((sum, travel) => sum + (parseFloat(travel.fare_amount) || 0), 0)
      : 0;
    const allowanceTotal =
      (Array.isArray(formData.journey_allowance) ? formData.journey_allowance.reduce((sum, row) => sum + ((parseFloat(row.amount) || 0) * (parseInt(row.no_of_days, 10) || 0)), 0) : 0) +
      (Array.isArray(formData.return_allowance) ? formData.return_allowance.reduce((sum, row) => sum + ((parseFloat(row.amount) || 0) * (parseInt(row.no_of_days, 10) || 0)), 0) : 0) +
      (Array.isArray(formData.stay_allowance) ? formData.stay_allowance.reduce((sum, row) => sum + ((parseFloat(row.amount) || 0) * (parseInt(row.no_of_days, 10) || 0)), 0) : 0);
    // Add hotel and food totals
    const hotelTotal = Array.isArray(formData.hotel_expenses)
      ? formData.hotel_expenses.reduce((sum, h) => sum + (parseFloat(h.billAmount) || 0), 0)
      : 0;
    const foodTotal = Array.isArray(formData.food_expenses)
      ? formData.food_expenses.reduce((sum, f) => sum + (parseFloat(f.billAmount) || 0), 0)
      : 0;
    const claimAmount = totalTravel + allowanceTotal + hotelTotal + foodTotal;
    // ---------------------------------------------------
    // Prevent submit if claimAmount is 0 or less
    if (claimAmount <= 0) {
      throw new Error('Total expense amount cannot be zero or less. Please enter at least one valid expense.');
    }

    // Only allow PDF for specialApproval
    const specialApprovalPath = req.files?.specialApproval?.[0]?.path || null;
    if (req.files?.specialApproval?.[0] && path.extname(req.files.specialApproval[0].originalname).toLowerCase() !== '.pdf') {
      // Remove uploaded file if not PDF
      fs.unlinkSync(req.files.specialApproval[0].path);
      return res.status(400).json({ message: 'Special Approval must be a PDF file.' });
    }

    // Insert expense form
    const [expenseResult] = await connection.query(
      `INSERT INTO expense_form (
        emp_id, project_id, claim_amount,
        travel_receipt_path,
        hotel_receipt_path,
        food_receipt_path,
        special_approval_path, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        formData.emp_id,
        projectId,
        claimAmount, // <-- use recalculated value
        req.files?.travelReceipt?.[0]?.path,
        req.files?.hotelReceipt?.[0]?.path,
        req.files?.foodReceipt?.[0]?.path,
        req.files?.specialApproval?.[0]?.path // <-- new field
      ]
    );

    const expenseId = expenseResult.insertId;

    // Insert into expense_projects with validated Allowance scope total
    await connection.query(
      `INSERT INTO expense_projects (
        expense_id, project_id, site_location, site_incharge_emp_code
      ) VALUES (?, ?, ?, ?)`,
      [
        expenseId,
        projectId,
        formData.project_code.toLowerCase() === 'general' ? formData.site_location.trim() : null,
        formData.project_code.toLowerCase() === 'general' ? formData.site_incharge_emp_code.trim() : null
      ]
    );

    // Insert travel data if exists
    if (Array.isArray(formData.travel_data) && formData.travel_data.length > 0) {
      for (const travel of formData.travel_data) {
        // Prevent negative fare_amount
        let fare = parseFloat(travel.fare_amount) || 0;
        if (fare < 0) fare = 0;
        await connection.query(
          `INSERT INTO travel_data (
            expense_id, emp_id, travel_date, from_location,
            to_location, mode_of_transport, fare_amount
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            formData.emp_id,
            travel.travel_date,
            travel.from_location,
            travel.to_location,
            travel.mode_of_transport,
            fare
          ]
        );
      }
    }

    // Insert journey_allowance
    if (Array.isArray(formData.journey_allowance)) {
      for (const ja of formData.journey_allowance) {
        await connection.query(
          `INSERT INTO journey_allowance (expense_id, emp_id, from_date, to_date, scope, no_of_days, amount)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            formData.emp_id,
            toMysqlDate(ja.from_date), // <-- FIX
            toMysqlDate(ja.to_date),   // <-- FIX
            ja.scope,
            ja.no_of_days,
            ja.amount
          ]
        );
      }
    }
    // Insert return_allowance
    if (Array.isArray(formData.return_allowance)) {
      for (const ra of formData.return_allowance) {
        await connection.query(
          `INSERT INTO return_allowance (expense_id, emp_id, from_date, to_date, scope, no_of_days, amount)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            formData.emp_id,
            toMysqlDate(ra.from_date), // <-- FIX
            toMysqlDate(ra.to_date),   // <-- FIX
            ra.scope,
            ra.no_of_days,
            ra.amount
          ]
        );
      }
    }
    // Insert stay_allowance
    if (Array.isArray(formData.stay_allowance)) {
      for (const sa of formData.stay_allowance) {
        await connection.query(
          `INSERT INTO stay_allowance (expense_id, emp_id, from_date, to_date, scope, no_of_days, amount)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            formData.emp_id,
            toMysqlDate(sa.from_date), // <-- FIX
            toMysqlDate(sa.to_date),   // <-- FIX
            sa.scope,
            sa.no_of_days,
            sa.amount
          ]
        );
      }
    }

    // Insert hotel_expenses
    if (Array.isArray(formData.hotel_expenses) && formData.hotel_expenses.length > 0) {
      for (const h of formData.hotel_expenses) {
        await connection.query(
          `INSERT INTO hotel_expenses (expense_id, from_date, to_date, sharing, location, bill_amount)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            toMysqlDate(h.fromDate),
            toMysqlDate(h.toDate),
            h.sharing,
            h.location,
            parseFloat(h.billAmount) || 0
          ]
        );
      }
    }

    // Insert food_expenses
    if (Array.isArray(formData.food_expenses) && formData.food_expenses.length > 0) {
      for (const f of formData.food_expenses) {
        await connection.query(
          `INSERT INTO food_expenses (expense_id, from_date, to_date, sharing, location, bill_amount)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            toMysqlDate(f.fromDate),
            toMysqlDate(f.toDate),
            parseInt(f.sharing, 10),
            f.location,
            parseFloat(f.billAmount) || 0
          ]
        );
      }
    }

    // Get employee's department(s)
    const [employeeDepartments] = await connection.query(
      `SELECT department_id FROM employees WHERE emp_id = ?`,
      [formData.emp_id]
    );
    const departmentIds = employeeDepartments.map(row => row.department_id);

    // Get all coordinators for these departments using the mapping table
    let coordinators = [];
    if (departmentIds.length > 0) {
      const [coordinatorRows] = await connection.query(
        `SELECT e.email, CONCAT(e.first_name, ' ', e.last_name) as name 
         FROM coordinator_departments cd
         JOIN employees e ON cd.coordinator_emp_id = e.emp_id
         JOIN users u ON e.emp_id = u.emp_id
         WHERE cd.department_id IN (?) AND u.role = 'coordinator'`,
        [departmentIds]
      );
      coordinators = coordinatorRows;
    }

    // Get employee details and all expense totals for email
    const [employee] = await connection.query(
      `SELECT e.emp_code, CONCAT(e.first_name, ' ', e.last_name) as name,
              d.department_name,
              p.project_code, p.project_name, p.site_location,
              des.designation_name
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.department_id
       LEFT JOIN projects p ON p.project_id = ?
       LEFT JOIN designations des ON e.designation_id = des.designation_id
       WHERE e.emp_id = ?`,
      [projectId, formData.emp_id]
    );

    // Calculate allowance/expense totals for email
    const daAllowanceTotal = allowanceTotal;
    const travelFareTotal = totalTravel;
    const foodExpenseTotal = foodTotal;
    const hotelExpenseTotal = hotelTotal;

    // Send email notifications
    try {
      for (const coordinator of coordinators) {
        await EmailService.sendEmail(
          coordinator.email,
          `New Expense Submission`,
          getExpenseSubmissionTemplate({
            recipientName: coordinator.name || 'N/A',
            employeeFirstName: formData.first_name || 'N/A',
            employeeMiddleName: formData.middle_name || '',
            employeeLastName: formData.last_name || 'N/A',
            employeeName: (employee[0]?.name || 'N/A'),
            employeeCode: employee[0]?.emp_code || 'N/A',
            designation: employee[0]?.designation_name || 'N/A',
            department: employee[0]?.department_name || 'N/A',
            projectCode: employee[0]?.project_code || 'N/A',
            projectName: employee[0]?.project_name || 'N/A',
            siteLocation: employee[0]?.site_location || 'N/A',
            daAllowanceTotal,
            travelFareTotal,
            foodExpenseTotal,
            hotelExpenseTotal,
            claimAmount
          })
        );
      }
    } catch (emailError) {
      // Continue with submission even if email fails
    }

    await connection.commit();
    res.status(201).json({ 
      message: 'Expense submitted successfully', 
      expenseId,
      projectId 
    });

  } catch (error) {
    await connection.rollback();
    res.status(400).json({ 
      message: error.message || 'Error submitting expense'
    });
  } finally {
    connection.release();
  }
});

// Add edit expense endpoint
router.put('/:expenseId', auth, upload.fields([
  { name: 'travelReceipt', maxCount: 1 },
  { name: 'specialApproval', maxCount: 1 },
  { name: 'hotelReceipt', maxCount: 1 },
  { name: 'foodReceipt', maxCount: 1 }
]), async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    
    const { expenseId } = req.params;
    const formData = JSON.parse(req.body.data);
    const userComment = formData.comment || null;

    // Calculate total expense (first calculation for validation)
    const totalTravel = Array.isArray(formData.travel_data)
      ? formData.travel_data.reduce((sum, travel) => {
          let fare = parseFloat(travel.fare_amount) || 0;
          if (fare < 0) fare = 0;
          return sum + fare;
        }, 0)
      : 0;
    const allowanceTotal =
      (Array.isArray(formData.journey_allowance) ? formData.journey_allowance.reduce((sum, row) => sum + ((parseFloat(row.amount) || 0) * (parseInt(row.no_of_days, 10) || 0)), 0) : 0) +
      (Array.isArray(formData.return_allowance) ? formData.return_allowance.reduce((sum, row) => sum + ((parseFloat(row.amount) || 0) * (parseInt(row.no_of_days, 10) || 0)), 0) : 0) +
      (Array.isArray(formData.stay_allowance) ? formData.stay_allowance.reduce((sum, row) => sum + ((parseFloat(row.amount) || 0) * (parseInt(row.no_of_days, 10) || 0)), 0) : 0);
    const hotelTotal = Array.isArray(formData.hotel_expenses)
      ? formData.hotel_expenses.reduce((sum, h) => sum + (parseFloat(h.billAmount) || 0), 0)
      : 0;
    const foodTotal = Array.isArray(formData.food_expenses)
      ? formData.food_expenses.reduce((sum, f) => sum + (parseFloat(f.billAmount) || 0), 0)
      : 0;
    const totalExpense = totalTravel + allowanceTotal + hotelTotal + foodTotal;
    if (totalExpense <= 0) {
      throw new Error('Total expense amount cannot be zero. Please enter at least one expense.');
    }

    // Get current expense details before updating
    const [currentExpense] = await connection.query(
      `SELECT ef.*, e.email as employee_email, 
              CONCAT(e.first_name, ' ', e.last_name) as employee_name,
              d.department_id, d.department_name
       FROM expense_form ef
       JOIN employees e ON ef.emp_id = e.emp_id
       LEFT JOIN departments d ON e.department_id = d.department_id
       WHERE expense_id = ?`,
      [expenseId]
    );

    // Check last history entry to avoid duplicate
    const [lastHistory] = await connection.query(
      `SELECT action, new_status, comment FROM expense_history WHERE expense_id = ? ORDER BY action_at DESC LIMIT 1`,
      [expenseId]
    );
    const isDuplicate = lastHistory.length > 0 && lastHistory[0].action === 'resubmitted' && lastHistory[0].new_status === 'pending' && lastHistory[0].comment === userComment;
    if (!isDuplicate) {
      // Add to history before updating, use manual comment
      await connection.query(
        `INSERT INTO expense_history (
          expense_id, emp_id, action, previous_status,
          new_status, comment, action_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          expenseId,
          req.user.emp_id,
          'resubmitted',
          'rejected',
          'pending',
          userComment,
          req.user.emp_id
        ]
      );
    }

    // Update project
    const [projectResult] = await connection.query(
      `INSERT INTO projects (project_code, project_name) 
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE project_name = VALUES(project_name)`,
      [formData.project_code, formData.project_name]
    );

    // Get project_id
    const [projectData] = await connection.query(
      'SELECT project_id FROM projects WHERE project_code = ?',
      [formData.project_code]
    );

    // --- SAFETY: Recalculate claim_amount on backend (use different variable names) ---
    const totalTravel2 = Array.isArray(formData.travel_data)
      ? formData.travel_data.reduce((sum, travel) => sum + (parseFloat(travel.fare_amount) || 0), 0)
      : 0;
    const allowanceTotal2 =
      (Array.isArray(formData.journey_allowance) ? formData.journey_allowance.reduce((sum, row) => sum + ((parseFloat(row.amount) || 0) * (parseInt(row.no_of_days, 10) || 0)), 0) : 0) +
      (Array.isArray(formData.return_allowance) ? formData.return_allowance.reduce((sum, row) => sum + ((parseFloat(row.amount) || 0) * (parseInt(row.no_of_days, 10) || 0)), 0) : 0) +
      (Array.isArray(formData.stay_allowance) ? formData.stay_allowance.reduce((sum, row) => sum + ((parseFloat(row.amount) || 0) * (parseInt(row.no_of_days, 10) || 0)), 0) : 0);
    // Add hotel and food totals
    const hotelTotal2 = Array.isArray(formData.hotel_expenses)
      ? formData.hotel_expenses.reduce((sum, h) => sum + (parseFloat(h.billAmount) || 0), 0)
      : 0;
    const foodTotal2 = Array.isArray(formData.food_expenses)
      ? formData.food_expenses.reduce((sum, f) => sum + (parseFloat(f.billAmount) || 0), 0)
      : 0;
    const claimAmount2 = totalTravel2 + allowanceTotal2 + hotelTotal2 + foodTotal2;
    // -------------------------------------------------------------------------------

    // Only allow PDF for specialApproval
    const specialApprovalPath = req.files?.specialApproval?.[0]?.path;
    if (req.files?.specialApproval?.[0] && path.extname(req.files.specialApproval[0].originalname).toLowerCase() !== '.pdf') {
      fs.unlinkSync(req.files.specialApproval[0].path);
      return res.status(400).json({ message: 'Special Approval must be a PDF file.' });
    }

    // --- Receipt deletion logic ---
    const deleteReceiptIfNeeded = async (field, dbField) => {
      if (req.body[`delete${field}`] === 'true' || req.body[`delete${field}`] === true || req.body[`delete${field}`] === 1 || req.body[`delete${field}`] === '1' || req.body[`delete${field}`] === 'yes') {
        // Get current path from DB
        const [rows] = await connection.query(`SELECT ${dbField} FROM expense_form WHERE expense_id = ?`, [expenseId]);
        const filePath = rows[0] && rows[0][dbField];
        if (filePath && fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (e) {}
        }
        await connection.query(`UPDATE expense_form SET ${dbField} = NULL WHERE expense_id = ?`, [expenseId]);
      }
    };
    await deleteReceiptIfNeeded('TravelReceipt', 'travel_receipt_path');
    await deleteReceiptIfNeeded('HotelReceipt', 'hotel_receipt_path');
    await deleteReceiptIfNeeded('FoodReceipt', 'food_receipt_path');
    await deleteReceiptIfNeeded('SpecialApproval', 'special_approval_path');

    // Update expense form
    const updateFields = [];
    const updateValues = [];
    if (req.files?.travelReceipt?.[0]?.path) { updateFields.push('travel_receipt_path = ?'); updateValues.push(req.files.travelReceipt[0].path); }
    if (req.files?.hotelReceipt?.[0]?.path) { updateFields.push('hotel_receipt_path = ?'); updateValues.push(req.files.hotelReceipt[0].path); }
    if (req.files?.foodReceipt?.[0]?.path) { updateFields.push('food_receipt_path = ?'); updateValues.push(req.files.foodReceipt[0].path); }
    if (req.files?.specialApproval?.[0]?.path) { updateFields.push('special_approval_path = ?'); updateValues.push(req.files.specialApproval[0].path); }
    if (updateFields.length) {
      await connection.query(
        `UPDATE expense_form SET ${updateFields.join(', ')}, 
          project_id = ?,
          claim_amount = ?,
          status = 'pending',
          coordinator_comment = NULL,
          hr_comment = NULL,
          accounts_comment = NULL,
          coordinator_reviewed_by = NULL,
          hr_reviewed_by = NULL,
          accounts_reviewed_by = NULL,
          coordinator_reviewed_at = NULL,
          hr_reviewed_at = NULL,
          accounts_reviewed_at = NULL
        WHERE expense_id = ?`,
        [...updateValues, projectData[0].project_id, claimAmount2, expenseId]
      );
    } else {
      await connection.query(
        `UPDATE expense_form SET 
          project_id = ?,
          claim_amount = ?,
          status = 'pending',
          coordinator_comment = NULL,
          hr_comment = NULL,
          accounts_comment = NULL,
          coordinator_reviewed_by = NULL,
          hr_reviewed_by = NULL,
          accounts_reviewed_by = NULL,
          coordinator_reviewed_at = NULL,
          hr_reviewed_at = NULL,
          accounts_reviewed_at = NULL
        WHERE expense_id = ?`,
        [projectData[0].project_id, claimAmount2, expenseId]
      );
    }

    // --- NEW: Update expense_projects with new site fields ---
    // Check if expense_projects row exists
    const [existingEP] = await connection.query(
      'SELECT expense_project_id FROM expense_projects WHERE expense_id = ?',
      [expenseId]
    );
    if (existingEP.length > 0) {
      // Update existing row
      await connection.query(
        `UPDATE expense_projects SET
          project_id = ?,
          site_location = ?,
          site_incharge_emp_code = ?
        WHERE expense_id = ?`,
        [
          projectData[0].project_id,
          formData.project_code && formData.project_code.toLowerCase() === 'general'
            ? (formData.site_location || '').trim()
            : null,
          formData.project_code && formData.project_code.toLowerCase() === 'general'
            ? (formData.site_incharge_emp_code || '').trim()
            : null,
          expenseId
        ]
      );
    } else {
      // Insert new row if not exists
      await connection.query(
        `INSERT INTO expense_projects (
          expense_id, project_id, site_location, site_incharge_emp_code
        ) VALUES (?, ?, ?, ?)`,
        [
          expenseId,
          projectData[0].project_id,
          formData.project_code && formData.project_code.toLowerCase() === 'general'
            ? (formData.site_location || '').trim()
            : null,
          formData.project_code && formData.project_code.toLowerCase() === 'general'
            ? (formData.site_incharge_emp_code || '').trim()
            : null
        ]
      );
    }
    // --------------------------------------------------------

    // Update travel data
    await connection.query('DELETE FROM travel_data WHERE expense_id = ?', [expenseId]);

    if (formData.travel_data && formData.travel_data.length > 0) {
      for (const travel of formData.travel_data) {
        // Prevent negative fare_amount
        let fare = parseFloat(travel.fare_amount) || 0;
        if (fare < 0) fare = 0;
        await connection.query(
          `INSERT INTO travel_data (
            expense_id, emp_id, travel_date, from_location,
            to_location, mode_of_transport, fare_amount
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            req.user.emp_id,
            travel.travel_date,
            travel.from_location,
            travel.to_location,
            travel.mode_of_transport,
            fare
          ]
        );
      }
    }

    // Remove old allowance records
    await connection.query('DELETE FROM journey_allowance WHERE expense_id = ?', [expenseId]);
    await connection.query('DELETE FROM return_allowance WHERE expense_id = ?', [expenseId]);
    await connection.query('DELETE FROM stay_allowance WHERE expense_id = ?', [expenseId]);

    // Insert new journey_allowance
    if (Array.isArray(formData.journey_allowance)) {
      for (const ja of formData.journey_allowance) {
        await connection.query(
          `INSERT INTO journey_allowance (expense_id, emp_id, from_date, to_date, scope, no_of_days, amount)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            req.user.emp_id,
            toMysqlDate(ja.from_date),
            toMysqlDate(ja.to_date),
            ja.scope,
            ja.no_of_days,
            ja.amount
          ]
        );
      }
    }
    // Insert new return_allowance
    if (Array.isArray(formData.return_allowance)) {
      for (const ra of formData.return_allowance) {
        await connection.query(
          `INSERT INTO return_allowance (expense_id, emp_id, from_date, to_date, scope, no_of_days, amount)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            req.user.emp_id,
            toMysqlDate(ra.from_date),
            toMysqlDate(ra.to_date),
            ra.scope,
            ra.no_of_days,
            ra.amount
          ]
        );
      }
    }
    // Insert new stay_allowance
    if (Array.isArray(formData.stay_allowance)) {
      for (const sa of formData.stay_allowance) {
        await connection.query(
          `INSERT INTO stay_allowance (expense_id, emp_id, from_date, to_date, scope, no_of_days, amount)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            req.user.emp_id,
            toMysqlDate(sa.from_date),
            toMysqlDate(sa.to_date),
            sa.scope,
            sa.no_of_days,
            sa.amount
          ]
        );
      }
    }

    // Remove old hotel_expenses records
    await connection.query('DELETE FROM hotel_expenses WHERE expense_id = ?', [expenseId]);
    // Insert new hotel_expenses
    if (Array.isArray(formData.hotel_expenses)) {
      for (const h of formData.hotel_expenses) {
        await connection.query(
          `INSERT INTO hotel_expenses (expense_id, from_date, to_date, sharing, location, bill_amount)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            toMysqlDate(h.fromDate),
            toMysqlDate(h.toDate),
            h.sharing,
            h.location,
            parseFloat(h.billAmount) || 0
          ]
        );
      }
    }

    // Remove old food_expenses records
    await connection.query('DELETE FROM food_expenses WHERE expense_id = ?', [expenseId]);
    // Insert new food_expenses
    if (Array.isArray(formData.food_expenses)) {
      for (const f of formData.food_expenses) {
        await connection.query(
          `INSERT INTO food_expenses (expense_id, from_date, to_date, sharing, location, bill_amount)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            expenseId,
            toMysqlDate(f.fromDate),
            toMysqlDate(f.toDate),
            parseInt(f.sharing, 10),
            f.location,
            parseFloat(f.billAmount) || 0
          ]
        );
      }
    }

    // After successful update, get coordinators and send notifications
    try {
      // Get all coordinators for the employee's department(s)
      const [employeeDepartments] = await connection.query(
        `SELECT department_id FROM employees WHERE emp_id = ?`,
        [formData.emp_id]
      );
      const departmentIds = employeeDepartments.map(row => row.department_id);
      let coordinators = [];
      if (departmentIds.length > 0) {
        const [coordinatorRows] = await connection.query(
          `SELECT e.email, CONCAT(e.first_name, ' ', e.last_name) as name 
           FROM coordinator_departments cd
           JOIN employees e ON cd.coordinator_emp_id = e.emp_id
           JOIN users u ON e.emp_id = u.emp_id
           WHERE cd.department_id IN (?) AND u.role = 'coordinator'`,
          [departmentIds]
        );
        coordinators = coordinatorRows;
      }
      // Get employee details for resubmission email
      const [employee] = await connection.query(
        `SELECT e.emp_code, CONCAT(e.first_name, ' ', e.last_name) as name,
                d.department_name,
                p.project_code, p.project_name, p.site_location,
                des.designation_name
         FROM employees e
         LEFT JOIN departments d ON e.department_id = d.department_id
         LEFT JOIN projects p ON p.project_id = ?
         LEFT JOIN designations des ON e.designation_id = des.designation_id
         WHERE e.emp_id = ?`,
        [projectData[0].project_id, formData.emp_id]
      );
      // Send resubmission email to all coordinators
      for (const coordinator of coordinators) {
        await EmailService.sendExpenseResubmissionEmail(
          coordinator.email,
          'Expense Resubmission',
          getExpenseResubmissionTemplate({
            recipientName: coordinator.name || 'N/A',
            employeeFirstName: formData.first_name || 'N/A',
            employeeMiddleName: formData.middle_name || '',
            employeeLastName: formData.last_name || 'N/A',
            employeeName: (employee[0]?.name || 'N/A'),
            employeeCode: employee[0]?.emp_code || 'N/A',
            designation: employee[0]?.designation_name || 'N/A',
            department: employee[0]?.department_name || 'N/A',
            projectCode: employee[0]?.project_code || 'N/A',
            projectName: employee[0]?.project_name || 'N/A',
            siteLocation: employee[0]?.site_location || 'N/A',
            daAllowanceTotal: allowanceTotal,
            travelFareTotal: totalTravel,
            foodExpenseTotal: foodTotal,
            hotelExpenseTotal: hotelTotal,
            claimAmount: claimAmount2
          })
        );
      }
    } catch (emailError) {
    }

    await connection.commit();
    res.json({ message: 'Expense updated and resubmitted successfully' });

  } catch (error) {
    await connection.rollback();
    res.status(500).json({ message: error.message || 'Server error' });
  } finally {
    connection.release();
  }
});

// Modify the review endpoint to enforce department match for coordinator self-approval
router.post('/:expenseId/review', auth, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const { action, comment } = req.body;
    const { expenseId } = req.params;

    // Get current expense with department info
    const [currentExpense] = await connection.query(
      `SELECT ef.*, e.department_id, e.emp_id, e.email as employee_email,
        CONCAT(e.first_name, ' ', e.last_name) as employee_name,
        CONCAT(reviewer.first_name, ' ', reviewer.last_name) as reviewer_name,
        reviewer.email as reviewer_email,
        d.department_name, p.project_code, p.project_name
       FROM expense_form ef
       JOIN employees e ON ef.emp_id = e.emp_id
       JOIN employees reviewer ON reviewer.emp_id = ?
       LEFT JOIN departments d ON e.department_id = d.department_id
       LEFT JOIN projects p ON ef.project_id = p.project_id
       WHERE ef.expense_id = ?`,
      [req.user.emp_id, expenseId]
    );

    if (!currentExpense[0]) {
      throw new Error('Expense not found');
    }

    // Check if coordinator can self-approve (must be assigned to their own department)
    let isSelfCoordinator = false;
    if (req.user.role === 'coordinator' && currentExpense[0].emp_id === req.user.emp_id) {
      // Only allow if user's department matches a coordinator_departments assignment
      const [deptCheck] = await connection.query(
        'SELECT * FROM coordinator_departments WHERE coordinator_emp_id = ? AND department_id = ?',
        [req.user.emp_id, currentExpense[0].department_id]
      );
      if (deptCheck.length > 0) {
        isSelfCoordinator = true;
      } else {
        // Restrict: If not assigned to their own department, cannot approve/reject
        throw new Error('You are not allowed to approve/reject your own expense. Your coordinator assignment does not match your department.');
      }
    }

    // Define valid transitions based on role and current status
    const validTransitions = {
      coordinator: {
        pending: {
          approve: 'coordinator_approved',
          reject: 'coordinator_rejected'
        }
      },
      hr: {
        coordinator_approved: {
          approve: 'hr_approved',
          reject: 'hr_rejected'
        }
      },
      accounts: {
        hr_approved: {
          approve: 'accounts_approved',
          reject: 'accounts_rejected'
        }
      },
      admin: {
        pending: {
          approve: 'coordinator_approved',
          reject: 'coordinator_rejected'
        },
        coordinator_approved: {
          approve: 'hr_approved',
          reject: 'hr_rejected'
        },
        hr_approved: {
          approve: 'accounts_approved',
          reject: 'accounts_rejected'
        }
      }
    };

    // If self-approval, allow transition for coordinator's own expense only if department matches
    let roleTransitions = validTransitions[req.user.role];
    let statusTransitions = roleTransitions?.[currentExpense[0].status];
    let newStatus = statusTransitions?.[action];
    if (isSelfCoordinator && currentExpense[0].status === 'pending' && ['approve', 'reject'].includes(action)) {
      newStatus = action === 'approve' ? 'coordinator_approved' : 'coordinator_rejected';
    }

    if (!newStatus) {
      throw new Error(`Invalid transition: ${req.user.role} cannot ${action} expense in status ${currentExpense[0].status}`);
    }

    // Update expense status and reviewer information
    const reviewerField = {
      coordinator_approved: 'coordinator_reviewed_by',
      coordinator_rejected: 'coordinator_reviewed_by',
      hr_approved: 'hr_reviewed_by',
      hr_rejected: 'hr_reviewed_by',
      accounts_approved: 'accounts_reviewed_by',
      accounts_rejected: 'accounts_reviewed_by'
    }[newStatus];

    const reviewTimeField = {
      coordinator_approved: 'coordinator_reviewed_at',
      coordinator_rejected: 'coordinator_reviewed_at',
      hr_approved: 'hr_reviewed_at',
      hr_rejected: 'hr_reviewed_at',
      accounts_approved: 'accounts_reviewed_at',
      accounts_rejected: 'accounts_reviewed_at'
    }[newStatus];

    const commentField = {
      coordinator_approved: 'coordinator_comment',
      coordinator_rejected: 'coordinator_comment',
      hr_approved: 'hr_comment',
      hr_rejected: 'hr_comment',
      accounts_approved: 'accounts_comment',
      accounts_rejected: 'accounts_comment'
    }[newStatus];

    await connection.query(
      `UPDATE expense_form 
       SET status = ?,
           ${reviewerField} = ?,
           ${reviewTimeField} = NOW(),
           ${commentField} = ?
       WHERE expense_id = ?`,
      [newStatus, req.user.emp_id, comment, expenseId]
    );

    // Insert history record only if not duplicate (check comment too)
    const [lastHistory] = await connection.query(
      `SELECT action, new_status, comment FROM expense_history WHERE expense_id = ? ORDER BY action_at DESC LIMIT 1`,
      [expenseId]
    );
    const isDuplicate = lastHistory.length > 0 && lastHistory[0].action === newStatus && lastHistory[0].new_status === newStatus && lastHistory[0].comment === comment;
    if (!isDuplicate) {
      await connection.query(
        `INSERT INTO expense_history 
          (expense_id, emp_id, action, previous_status, new_status, comment, action_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          expenseId,
          currentExpense[0].emp_id,
          newStatus,
          currentExpense[0].status,
          newStatus,
          comment,
          req.user.emp_id
        ]
      );
    }

    // Prepare full email data for all reviewers
    // Always fetch latest designation and site location from joined tables
    const [expenseDetails] = await connection.query(
      `SELECT ef.*, e.first_name, e.middle_name, e.last_name, e.emp_code, e.email as employee_email,
              d.department_name, des.designation_name,
              p.project_code, p.project_name, p.site_location,
              ep.site_location AS expense_site_location
       FROM expense_form ef
       JOIN employees e ON ef.emp_id = e.emp_id
       LEFT JOIN departments d ON e.department_id = d.department_id
       LEFT JOIN designations des ON e.designation_id = des.designation_id
       LEFT JOIN projects p ON ef.project_id = p.project_id
       LEFT JOIN expense_projects ep ON ef.expense_id = ep.expense_id
       WHERE ef.expense_id = ?`,
      [expenseId]
    );
    // Calculate totals for email
    const [hotelExpenses] = await connection.query(
      `SELECT SUM(bill_amount) as total FROM hotel_expenses WHERE expense_id = ?`, [expenseId]
    );
    const [foodExpenses] = await connection.query(
      `SELECT SUM(bill_amount) as total FROM food_expenses WHERE expense_id = ?`, [expenseId]
    );
    const [travelExpenses] = await connection.query(
      `SELECT SUM(fare_amount) as total FROM travel_data WHERE expense_id = ?`, [expenseId]
    );
    const [journeyAllowance] = await connection.query(
      `SELECT SUM(amount * no_of_days) as total FROM journey_allowance WHERE expense_id = ?`, [expenseId]
    );
    const [returnAllowance] = await connection.query(
      `SELECT SUM(amount * no_of_days) as total FROM return_allowance WHERE expense_id = ?`, [expenseId]
    );
    const [stayAllowance] = await connection.query(
      `SELECT SUM(amount * no_of_days) as total FROM stay_allowance WHERE expense_id = ?`, [expenseId]
    );
    const daAllowanceTotal = Number(journeyAllowance[0].total || 0) + Number(returnAllowance[0].total || 0) + Number(stayAllowance[0].total || 0);
    const travelFareTotal = Number(travelExpenses[0].total || 0);
    const foodExpenseTotal = Number(foodExpenses[0].total || 0);
    const hotelExpenseTotal = Number(hotelExpenses[0].total || 0);
    const claimAmount = Number(expenseDetails[0].claim_amount || 0);
    const fullEmailData = {
      status: newStatus,
      previousStatus: currentExpense[0].status || 'pending',
      comment,
      reviewerName: currentExpense[0].reviewer_name || '',
      employeeName: (expenseDetails[0].first_name || expenseDetails[0].middle_name || expenseDetails[0].last_name)
        ? `${expenseDetails[0].first_name || ''}${expenseDetails[0].middle_name ? ' ' + expenseDetails[0].middle_name : ''}${expenseDetails[0].last_name ? ' ' + expenseDetails[0].last_name : ''}`.replace(/\s+/g, ' ').trim()
        : expenseDetails[0].employee_name,
      employeeCode: expenseDetails[0].emp_code || '',
      department: expenseDetails[0].department_name || '',
      designation: expenseDetails[0].designation_name || '',
      projectCode: expenseDetails[0].project_code || '',
      projectName: expenseDetails[0].project_name || '',
      siteLocation: expenseDetails[0].expense_site_location || expenseDetails[0].site_location || '',
      daAllowanceTotal: daAllowanceTotal > 0 ? daAllowanceTotal : '',
      travelFareTotal: travelFareTotal > 0 ? travelFareTotal : '',
      foodExpenseTotal: foodExpenseTotal > 0 ? foodExpenseTotal : '',
      hotelExpenseTotal: hotelExpenseTotal > 0 ? hotelExpenseTotal : '',
      claimAmount: claimAmount > 0 ? claimAmount : '',
      recipientName: '',
      requiresAction: true
    };

    // Email notification handling
    try {
      // 1. Always notify the employee
      await EmailService.sendEmail(
        currentExpense[0].employee_email,
        `Expense Status Update: ${newStatus}`,
        getExpenseStatusEmailTemplate({
          ...fullEmailData,
          recipientName: currentExpense[0].employee_name,
          isSubmitter: true
        })
      );

      // 2. Handle workflow transitions
      if (action === 'approve') {
        if (newStatus === 'coordinator_approved' || newStatus === 'hr_approved') {
          // Fetch full expense details for email
          const [expenseDetails] = await connection.query(
            `SELECT ef.*, e.first_name, e.middle_name, e.last_name, e.emp_code,
                    d.department_name, des.designation_name,
                    p.project_code, p.project_name, p.site_location
             FROM expense_form ef
             JOIN employees e ON ef.emp_id = e.emp_id
             LEFT JOIN departments d ON e.department_id = d.department_id
             LEFT JOIN designations des ON e.designation_id = des.designation_id
             LEFT JOIN projects p ON ef.project_id = p.project_id
             WHERE ef.expense_id = ?`,
            [expenseId]
          );
          // Calculate totals for email
          const [hotelExpenses] = await connection.query(
            `SELECT SUM(bill_amount) as total FROM hotel_expenses WHERE expense_id = ?`, [expenseId]
          );
          const [foodExpenses] = await connection.query(
            `SELECT SUM(bill_amount) as total FROM food_expenses WHERE expense_id = ?`, [expenseId]
          );
          const [travelExpenses] = await connection.query(
            `SELECT SUM(fare_amount) as total FROM travel_data WHERE expense_id = ?`, [expenseId]
          );
          const [journeyAllowance] = await connection.query(
            `SELECT SUM(amount * no_of_days) as total FROM journey_allowance WHERE expense_id = ?`, [expenseId]
          );
          const [returnAllowance] = await connection.query(
            `SELECT SUM(amount * no_of_days) as total FROM return_allowance WHERE expense_id = ?`, [expenseId]
          );
          const [stayAllowance] = await connection.query(
            `SELECT SUM(amount * no_of_days) as total FROM stay_allowance WHERE expense_id = ?`, [expenseId]
          );
          const daAllowanceTotal = Number(journeyAllowance[0].total || 0) + Number(returnAllowance[0].total || 0) + Number(stayAllowance[0].total || 0);
          const travelFareTotal = Number(travelExpenses[0].total || 0);
          const foodExpenseTotal = Number(foodExpenses[0].total || 0);
          const hotelExpenseTotal = Number(hotelExpenses[0].total || 0);
          const claimAmount = Number(expenseDetails[0].claim_amount || 0);

          let nextReviewers = [];
          if (newStatus === 'coordinator_approved') {
            // Get HR users
            const [hrUsers] = await connection.query(
              `SELECT DISTINCT e.email, CONCAT(e.first_name, ' ', e.last_name) as name
               FROM employees e
               JOIN users u ON e.emp_id = u.emp_id
               WHERE u.role = 'hr' AND e.email IS NOT NULL`
            );
            nextReviewers = hrUsers;
            for (const reviewer of nextReviewers) {
              if (reviewer.email) {
                await EmailService.sendEmail(
                  reviewer.email,
                  `Action Required: New Expense Review`,
                  getExpenseStatusEmailTemplate({
                    ...fullEmailData,
                    reviewerName: reviewer.name,
                    recipientName: reviewer.name,
                    requiresAction: true
                  })
                );
              }
            }
          }
          if (newStatus === 'hr_approved') {
            // Get Accounts users
            const [accountsUsers] = await connection.query(
              `SELECT DISTINCT e.email, CONCAT(e.first_name, ' ', e.last_name) as name
               FROM employees e
               JOIN users u ON e.emp_id = u.emp_id
               WHERE u.role = 'accounts' AND e.email IS NOT NULL`
            );
            nextReviewers = accountsUsers;
            for (const reviewer of nextReviewers) {
              if (reviewer.email) {
                await EmailService.sendEmail(
                  reviewer.email,
                  `Action Required: New Expense Review`,
                  getExpenseStatusEmailTemplate({
                    ...fullEmailData,
                    reviewerName: reviewer.name,
                    recipientName: reviewer.name,
                    requiresAction: true
                  })
                );
              }
            }
          }
        }
        // After HR or Accounts approval, also notify the submitter with full expense details
        if (action === 'approve' && (newStatus === 'hr_approved' || newStatus === 'accounts_approved')) {
          // Fetch full expense details for email
          const [expenseDetails] = await connection.query(
            `SELECT ef.*, e.first_name, e.middle_name, e.last_name, e.emp_code,
                    d.department_name, des.designation_name,
                    p.project_code, p.project_name, p.site_location
             FROM expense_form ef
             JOIN employees e ON ef.emp_id = e.emp_id
             LEFT JOIN departments d ON e.department_id = d.department_id
             LEFT JOIN designations des ON e.designation_id = des.designation_id
             LEFT JOIN projects p ON ef.project_id = p.project_id
             WHERE ef.expense_id = ?`,
            [expenseId]
          );
          // Calculate totals for email
          const [hotelExpenses] = await connection.query(
            `SELECT SUM(bill_amount) as total FROM hotel_expenses WHERE expense_id = ?`, [expenseId]
          );
          const [foodExpenses] = await connection.query(
            `SELECT SUM(bill_amount) as total FROM food_expenses WHERE expense_id = ?`, [expenseId]
          );
          const [travelExpenses] = await connection.query(
            `SELECT SUM(fare_amount) as total FROM travel_data WHERE expense_id = ?`, [expenseId]
          );
          const [journeyAllowance] = await connection.query(
            `SELECT SUM(amount * no_of_days) as total FROM journey_allowance WHERE expense_id = ?`, [expenseId]
          );
          const [returnAllowance] = await connection.query(
            `SELECT SUM(amount * no_of_days) as total FROM return_allowance WHERE expense_id = ?`, [expenseId]
          );
          const [stayAllowance] = await connection.query(
            `SELECT SUM(amount * no_of_days) as total FROM stay_allowance WHERE expense_id = ?`, [expenseId]
          );
          const daAllowanceTotal = Number(journeyAllowance[0].total || 0) + Number(returnAllowance[0].total || 0) + Number(stayAllowance[0].total || 0);
          const travelFareTotal = Number(travelExpenses[0].total || 0);
          const foodExpenseTotal = Number(foodExpenses[0].total || 0);
          const hotelExpenseTotal = Number(hotelExpenses[0].total || 0);
          const claimAmount = Number(expenseDetails[0].claim_amount || 0);
          // Send email to submitter
          await EmailService.sendEmail(
            expenseDetails[0].email,
            `Expense Status Update: ${newStatus}`,
            getExpenseStatusEmailTemplate({
              ...fullEmailData,
              reviewerName: currentExpense[0].reviewer_name,
              recipientName: expenseDetails[0].employee_name,
              requiresAction: false
            })
          );
        }
      }

      // 3. If rejected, notify previous approvers
      if (action === 'reject') {
        // Get previous approvers from expense_form
        const approverFields = [
          { field: 'coordinator_reviewed_by', role: 'coordinator' },
          { field: 'hr_reviewed_by', role: 'hr' },
          { field: 'accounts_reviewed_by', role: 'accounts' }
        ];
        for (const { field, role } of approverFields) {
          const approverId = currentExpense[0][field];
          if (approverId) {
            // Get approver email and name
            const [approverRows] = await connection.query(
              `SELECT e.email, CONCAT(e.first_name, ' ', e.last_name) as name
               FROM employees e
               WHERE e.emp_id = ?`,
              [approverId]
            );
            if (approverRows.length && approverRows[0].email) {
              await EmailService.sendEmail(
                approverRows[0].email,
                `Expense Rejected`,
                getExpenseStatusEmailTemplate({
                  ...fullEmailData,
                  recipientName: approverRows[0].name,
                  comment: comment,
                  reviewerName: currentExpense[0].reviewer_name,
                  status: newStatus,
                  previousStatus: currentExpense[0].status,
                  requiresAction: false
                })
              );
            }
          }
        }
      }
    } catch (emailError) {
      // Continue with transaction even if email fails
    }

    await connection.commit();
    res.json({
      message: 'Review submitted successfully',
      status: newStatus
    });

  } catch (error) {
    await connection.rollback();
    res.status(403).json({ message: error.message });
  } finally {
    connection.release();
  }
});

// Update the expense history endpoint
router.get('/:expenseId/history', auth, async (req, res) => {
  const connection = await db.getConnection();
  try {
    const [history] = await connection.query(
      `SELECT 
        h.*,
        e.first_name,
        e.middle_name,
        e.last_name,
        e.emp_code as actor_code,
        u.role as actor_role,
        DATE_FORMAT(h.action_at, '%d-%m-%Y %H:%i:%s') as formatted_date
       FROM expense_history h
       LEFT JOIN employees e ON h.action_by = e.emp_id
       LEFT JOIN users u ON e.emp_id = u.emp_id
       WHERE h.expense_id = ?
       ORDER BY h.action_at DESC`,
      [req.params.expenseId]
    );

    // Filter out system-generated status change comments
    const filteredHistory = history.filter(h => !h.comment || !h.comment.startsWith('Status changed from'));

    // Compose actor_name with middle name if present
    const mappedHistory = filteredHistory.map(h => ({
      ...h,
      actor_name: (h.first_name || h.middle_name || h.last_name)
        ? `${h.first_name || ''}${h.middle_name ? ' ' + h.middle_name : ''}${h.last_name ? ' ' + h.last_name : ''}`.replace(/\s+/g, ' ').trim()
        : h.actor_name
    }));

    res.json(mappedHistory);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching expense history' });
  } finally {
    connection.release();
  }
});

// Add a new endpoint to get expense history with normalized child data
router.get('/:expenseId/history-with-data', auth, async (req, res) => {
  try {
    // Fetch main history rows
    const [historyRows] = await db.query(
      `SELECT h.*, 
        e.first_name, e.last_name, e.emp_code
       FROM expense_history h
       JOIN employees e ON h.action_by = e.emp_id
       WHERE h.expense_id = ?
       ORDER BY h.action_at DESC`,
      [req.params.expenseId]
    );

    // Filter out system-generated status change comments
    const filteredRows = historyRows.filter(row => !row.comment || !row.comment.startsWith('Status changed from'));

    // For each history row, fetch child arrays
    const historyWithDetails = await Promise.all(filteredRows.map(async (row) => {
      const [journey] = await db.query(
        'SELECT from_date, to_date, scope, no_of_days, amount FROM expense_history_journey WHERE history_id = ?',
        [row.history_id]
      );
      const [returnArr] = await db.query(
        'SELECT from_date, to_date, scope, no_of_days, amount FROM expense_history_return WHERE history_id = ?',
        [row.history_id]
      );
      const [stay] = await db.query(
        'SELECT from_date, to_date, scope, no_of_days, amount FROM expense_history_stay WHERE history_id = ?',
        [row.history_id]
      );
      const [hotel] = await db.query(
        'SELECT from_date, to_date, sharing, location, bill_amount FROM expense_history_hotel WHERE history_id = ?',
        [row.history_id]
      );
      const [food] = await db.query(
        'SELECT from_date, to_date, sharing, location, bill_amount FROM expense_history_food WHERE history_id = ?',
        [row.history_id]
      );
      return {
        ...row,
        journey_allowance: journey,
        return_allowance: returnArr,
        stay_allowance: stay,
        hotel_expenses: hotel,
        food_expenses: food
      };
    }));

    res.json(historyWithDetails);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch expense history' });
  }
});

// Get single expense with full details
router.get('/:expenseId', auth, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Get main expense details with joined data
    const [expenses] = await connection.query(
      `SELECT ef.*, e.emp_code, e.first_name, e.middle_name, e.last_name,
              d.department_name, des.designation_name, des.designation_id,
              p.project_code, p.project_name,
              ep.site_location AS expense_site_location,
              ep.site_incharge_emp_code AS expense_site_incharge_emp_code,
              p.site_location AS project_site_location,
              p.site_incharge_emp_code AS project_site_incharge_emp_code
       FROM expense_form ef
       JOIN employees e ON ef.emp_id = e.emp_id
       LEFT JOIN departments d ON e.department_id = d.department_id
       LEFT JOIN designations des ON e.designation_id = des.designation_id
       LEFT JOIN projects p ON ef.project_id = p.project_id
       LEFT JOIN expense_projects ep ON ef.expense_id = ep.expense_id
       WHERE ef.expense_id = ?`,
      [req.params.expenseId]
    );

    if (!expenses.length) {
      throw new Error('Expense not found');
    }

    // Get travel data
    const [travelData] = await connection.query(
      `SELECT 
        travel_id,
        DATE_FORMAT(travel_date, '%Y-%m-%d') AS travel_date,
        from_location,
        to_location,
        mode_of_transport,
        fare_amount
       FROM travel_data 
       WHERE expense_id = ?
       ORDER BY travel_date`,
      [req.params.expenseId]
    );

    // Format dates in travel data
    const formattedTravelData = travelData.map(travel => ({
      ...travel,
      travel_date: travel.travel_date
        ? (typeof travel.travel_date === 'string'
            ? travel.travel_date
            : travel.travel_date.toISOString().split('T')[0])
        : null,
      fare_amount: parseFloat(travel.fare_amount)
    }));

    // Get journey_allowance (all fields)
    const [journeyAllowance] = await connection.query(
      `SELECT * FROM journey_allowance WHERE expense_id = ?`, [req.params.expenseId]
    );
    // Get return_allowance (all fields)
    const [returnAllowance] = await connection.query(
      `SELECT * FROM return_allowance WHERE expense_id = ?`, [req.params.expenseId]
    );
    // Get stay_allowance (all fields)
    const [stayAllowance] = await connection.query(
      `SELECT * FROM stay_allowance WHERE expense_id = ?`, [req.params.expenseId]
    );

    // Get hotel_expenses
    const [hotelExpenses] = await connection.query(
      `SELECT * FROM hotel_expenses WHERE expense_id = ?`, [req.params.expenseId]
    );

    // Get food_expenses
    const [foodExpenses] = await connection.query(
      `SELECT * FROM food_expenses WHERE expense_id = ?`, [req.params.expenseId]
    );

    // Helper to group by scope for each allowance type
    function groupAllowanceByScope(allowanceArr) {
      const result = {};
      allowanceArr.forEach(row => {
        if (!row.scope) return;
        if (!result[row.scope]) {
          result[row.scope] = { totalDays: 0, amountPerDay: row.amount, entries: [] };
        }
        result[row.scope].totalDays += Number(row.no_of_days) || 0;
        result[row.scope].amountPerDay = row.amount;
        result[row.scope].entries.push(row);
      });
      return Object.entries(result).map(([scope, data]) => ({
        scope,
        totalDays: data.totalDays,
        amountPerDay: data.amountPerDay,
        totalAmount: Number(data.amountPerDay || 0) * data.totalDays,
        entries: data.entries
      }));
    }

    // Helper to get total days per scope across all allowance types
    function getTotalDaysAllScopes(journey, ret, stay) {
      const scopes = {};
      [journey, ret, stay].forEach(arr => {
        arr.forEach(row => {
          if (!row.scope) return;
          if (!scopes[row.scope]) scopes[row.scope] = 0;
          scopes[row.scope] += Number(row.no_of_days) || 0;
        });
      });
      return scopes;
    }

    // Fetch allowance rates for this employee's designation
    const designationId = expenses[0].designation_id;
    let allowanceRates = [];
    if (designationId) {
      const [rates] = await connection.query(
        `SELECT scope, amount FROM allowance_rates WHERE designation_id = ?`,
        [designationId]
      );
      allowanceRates = rates;
    }

    // Combine all data
    const fullExpenseData = {
      ...expenses[0],
      employee_name: (expenses[0].first_name || expenses[0].middle_name || expenses[0].last_name)
        ? `${expenses[0].first_name || ''}${expenses[0].middle_name ? ' ' + expenses[0].middle_name : ''}${expenses[0].last_name ? ' ' + expenses[0].last_name : ''}`.replace(/\s+/g, ' ').trim()
        : expenses[0].employee_name,
      first_name: expenses[0].first_name,
      middle_name: expenses[0].middle_name,
      last_name: expenses[0].last_name,
      travel_data: formattedTravelData,
      site_location: expenses[0].expense_site_location || expenses[0].project_site_location || '',
      site_incharge_emp_code: expenses[0].expense_site_incharge_emp_code || expenses[0].project_site_incharge_emp_code || '',
      journey_allowance: journeyAllowance, // full raw rows
      return_allowance: returnAllowance,   // full raw rows
      stay_allowance: stayAllowance,       // full raw rows
      hotel_expenses: hotelExpenses,       // full raw rows
      food_expenses: foodExpenses,         // full raw rows
      journey_allowance_grouped: groupAllowanceByScope(journeyAllowance),
      return_allowance_grouped: groupAllowanceByScope(returnAllowance),
      stay_allowance_grouped: groupAllowanceByScope(stayAllowance),
      allowance_scope_totals: getTotalDaysAllScopes(journeyAllowance, returnAllowance, stayAllowance),
      allowance_rates: allowanceRates, // all fields from allowance_rates
      hotel_receipt_path: expenses[0].hotel_receipt_path,
      food_receipt_path: expenses[0].food_receipt_path,
      travel_receipt_path: expenses[0].travel_receipt_path,
      special_approval_path: expenses[0].special_approval_path
    };

    await connection.commit();
    res.json(fullExpenseData);

  } catch (error) {
    await connection.rollback();
    res.status(500).json({ message: error.message || 'Server error' });
  } finally {
    connection.release();
  }
});

// Add new CSV upload route for projects
router.post('/projects/upload-csv', auth, upload.single('file'), async (req, res) => {
  // Allow both admin and hr to upload project data
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Only admin or HR can upload project data' });
  }

  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  const results = [];
  const errors = [];

  try {
    let records = [];
    if (req.file.originalname.endsWith('.xlsx')) {
      // Parse XLSX file
      const workbook = xlsx.readFile(req.file.path);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      records = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
    } else {
      // Parse CSV file
      const parser = fs.createReadStream(req.file.path)
        .pipe(parse({
          columns: true,
          skip_empty_lines: true,
          trim: true
        }));
      for await (const record of parser) {
        records.push(record);
      }
    }

    for (const record of records) {
      try {
        // Validate required fields
        if (!record.project_code || !record.project_name) {
          errors.push(`Missing required fields for project: ${JSON.stringify(record)}`);
          continue;
        }

        // Check for duplicate project code
        const [existingProject] = await db.query(
          'SELECT project_id FROM projects WHERE project_code = ?',
          [record.project_code]
        );

        if (existingProject.length > 0) {
          errors.push(`Project with code ${record.project_code} already exists`);
          continue;
        }

        // Insert project with new fields
        await db.query(
          'INSERT INTO projects (project_code, project_name, site_location, site_incharge_emp_code) VALUES (?, ?, ?, ?)',
          [
            record.project_code,
            record.project_name,
            record.site_location || null,
            record.site_incharge_emp_code || null
          ]
        );

        results.push({
          project_code: record.project_code,
          status: 'success',
          message: 'Project added successfully'
        });

      } catch (error) {
        errors.push(`Error processing project ${record.project_code || 'unknown'}: ${error.message}`);
      }
    }

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.json({
      message: 'File processing completed',
      totalProcessed: results.length + errors.length,
      successCount: results.length,
      errorCount: errors.length,
      successRecords: results,
      errors: errors
    });

  } catch (error) {
    // Clean up uploaded file in case of error
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ message: 'Error processing file', error: error.message });
  }
});

// Add this new endpoint for fetching allowance rates
router.get('/allowance-rates/:designationId', auth, async (req, res) => {
  try {
    const { designationId } = req.params;
    
    const [rates] = await db.query(
      `SELECT ar.*, d.designation_name 
       FROM allowance_rates ar
       JOIN designations d ON ar.designation_id = d.designation_id
       WHERE ar.designation_id = ?`,
      [designationId]
    );

    res.json(rates);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching allowance rates' });
  }
});

// Get all allowance entries for all expenses (for admin/reporting)
router.get('/all-allowances', auth, async (req, res) => {
  try {
    // Only allow admin or HR to fetch all allowances
    if (req.user.role !== 'admin' && req.user.role !== 'hr') {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    // Fetch all journey_allowance
    const [journey] = await db.query(
      `SELECT * FROM journey_allowance ORDER BY expense_id, id`
    );
    // Fetch all return_allowance
    const [ret] = await db.query(
      `SELECT * FROM return_allowance ORDER BY expense_id, id`
    );
    // Fetch all stay_allowance
    const [stay] = await db.query(
      `SELECT * FROM stay_allowance ORDER BY expense_id, id`
    );

    res.json({
      journey_allowance: journey,
      return_allowance: ret,
      stay_allowance: stay
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

