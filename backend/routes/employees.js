const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse');
const xlsx = require('xlsx');
const crypto = require('crypto');
const EmailService = require('../services/emailService');
const jwt = require('jsonwebtoken'); // For reset token (if not already imported)
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
    let folder = 'profile_images';
    if (file.mimetype === 'application/pdf') folder = 'pdfs';
    return {
      folder,
      allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
      public_id: Date.now() + '-' + file.originalname.replace(/\s+/g, '_')
    };
  }
});
const upload = multer({ storage });

// Get all employees (allow all authenticated users for autocomplete)
router.get('/all', auth, async (req, res) => {
  try {
    const [employees] = await db.query(`
      SELECT 
        e.emp_id,
        e.emp_code,
        e.username,
        e.first_name,
        e.middle_name,
        e.last_name,
        e.full_name,
        e.email,
        e.mobile_number,
        e.designation_id,
        ds.designation_name,
        e.department_id,
        d.department_name,
        e.location_id,
        l.location_name,
        e.date_of_joining,
        e.category,
        e.gender,
        e.birth_of_date,
        e.first_reporting_manager_emp_code,
        rm1.emp_id AS first_reporting_manager_id,
        CONCAT(rm1.emp_code, ' - ', rm1.first_name, ' ', IFNULL(rm1.middle_name, ''), ' ', rm1.last_name) AS first_reporting_manager_name,
        e.second_reporting_manager_emp_code,
        rm2.emp_id AS second_reporting_manager_id,
        CONCAT(rm2.emp_code, ' - ', rm2.first_name, ' ', IFNULL(rm2.middle_name, ''), ' ', rm2.last_name) AS second_reporting_manager_name,
        e.last_employment_date,
        u.status,
        u.role,
        u.inactive_reason,
        u.tab_permissions
      FROM employees e
      LEFT JOIN users u ON e.emp_id = u.emp_id
      LEFT JOIN departments d ON e.department_id = d.department_id
      LEFT JOIN designations ds ON e.designation_id = ds.designation_id
      LEFT JOIN locations l ON e.location_id = l.location_id
      LEFT JOIN employees rm1 ON e.first_reporting_manager_emp_code = rm1.emp_code
      LEFT JOIN employees rm2 ON e.second_reporting_manager_emp_code = rm2.emp_code
      ORDER BY e.emp_code
    `);

    res.json(employees.map(emp => ({
      ...emp,
      full_name: (emp.first_name || emp.middle_name || emp.last_name)
        ? `${emp.first_name || ''}${emp.middle_name ? ' ' + emp.middle_name : ''}${emp.last_name ? ' ' + emp.last_name : ''}`.replace(/\s+/g, ' ').trim()
        : emp.full_name,
      first_name: emp.first_name,
      middle_name: emp.middle_name,
      last_name: emp.last_name,
      inactive_reason: emp.inactive_reason,
      tab_permissions: emp.tab_permissions ? JSON.parse(emp.tab_permissions) : undefined
    })));
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all employees who are not activated and whose token is expired
router.get('/not-activated', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Access denied.' });
  }
  try {
    // Only return employees who are not activated AND whose latest token is expired
    const [rows] = await db.query(`
      SELECT e.emp_id, e.emp_code, e.email, e.first_name, u.status, t.token, t.expires_at
      FROM employees e
      LEFT JOIN users u ON e.emp_id = u.emp_id
      LEFT JOIN user_activation_tokens t ON e.emp_id = t.emp_id
      WHERE (u.status IS NULL OR u.status != 'active')
        AND t.token IS NOT NULL AND t.expires_at IS NOT NULL AND t.expires_at < NOW()
        AND t.expires_at = (
          SELECT MAX(t2.expires_at) FROM user_activation_tokens t2 WHERE t2.emp_id = e.emp_id
        )
      ORDER BY e.emp_code
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Bulk resend activation links to not activated employees (accepts emp_ids array)
router.post('/bulk-resend-activation', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Access denied.' });
  }
  const empIds = Array.isArray(req.body.emp_ids) ? req.body.emp_ids : [];
  if (empIds.length === 0) {
    return res.status(400).json({ message: 'No employee IDs provided.' });
  }
  try {
    // Only select employees whose token is expired and are in the selected list
    const [rows] = await db.query(`
      SELECT e.emp_id, e.email, e.first_name, t.expires_at
      FROM employees e
      LEFT JOIN users u ON e.emp_id = u.emp_id
      LEFT JOIN user_activation_tokens t ON e.emp_id = t.emp_id
      WHERE e.emp_id IN (?)
        AND ((u.status IS NULL OR u.status != 'active')
        AND t.token IS NOT NULL AND t.expires_at < NOW())
    `, [empIds]);
    let success = 0, failed = 0;
    for (const emp of rows) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24 hours
      await db.query(
        'INSERT INTO user_activation_tokens (emp_id, token, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE token=?, expires_at=?',
        [emp.emp_id, token, expiresAt, token, expiresAt]
      );
      const activationLink = `${process.env.FRONTEND_URL}/activate-account?token=${token}`;
      try {
        await EmailService.sendEmail(
          emp.email,
          'Activate your Expense Tracker Account',
          `<div style="font-family: Arial, sans-serif; background: #f8f9fa; padding: 32px;">
            <h2 style="color: #1976d2;">Welcome to Expense Tracker, ${emp.first_name}!</h2>
            <p>Your employee account has been created. To activate your user account and set your password, please click the button below:</p>
            <p style="margin: 24px 0;">
              <a href="${activationLink}" style="background: #1976d2; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 1.1rem;">
                Activate Account
              </a>
            </p>
            <p>Your email: <b>${emp.email}</b></p>
            <p>This link will expire in <b>24 hours</b>.</p>
            <hr style="margin: 32px 0;">
            <p style="color: #888; font-size: 0.95rem;">If you did not request this, please ignore this email or contact HR.</p>
          </div>`
        );
        success++;
      } catch (emailError) {
        failed++;
      }
    }
    res.json({ message: `Activation links resent. Success: ${success}, Failed: ${failed}` });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all departments
router.get('/departments', auth, async (req, res) => {
  try {
    console.log('Fetching departments...');
    const [departments] = await db.query('SELECT * FROM departments ORDER BY department_name');
    // console.log('Found departments:', departments);
    res.json(departments);
  } catch (error) {
    console.error('Error fetching departments:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all coordinator-department mappings
router.get('/coordinator-departments', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT cd.id, cd.coordinator_emp_id, cd.department_id,
        e.emp_code AS coordinator_emp_code,
        CONCAT(e.first_name, ' ', IFNULL(e.middle_name, ''), ' ', e.last_name) AS coordinator_name,
        d.department_name
      FROM coordinator_departments cd
      JOIN employees e ON cd.coordinator_emp_id = e.emp_id
      JOIN departments d ON cd.department_id = d.department_id
      ORDER BY cd.id
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching mappings' });
  }
});

// Add new department
router.post('/departments', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Only admin or HR can add departments' });
  }

  try {
    const { department_name } = req.body;
    await db.query(
      'INSERT INTO departments (department_name) VALUES (?)',
      [department_name]
    );
    res.status(201).json({ message: 'Department added successfully' });
  } catch (error) {
    console.error('Error adding department:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update department
router.put('/departments/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Only admin or HR can update departments' });
  }

  try {
    const { department_name } = req.body;
    await db.query(
      'UPDATE departments SET department_name = ? WHERE department_id = ?',
      [department_name, req.params.id]
    );
    res.json({ 
      message: 'Department updated successfully',
      department_name: department_name
    });
  } catch (error) {
    console.error('Error updating department:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete department
router.delete('/departments/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Only admin or HR can delete departments' });
  }

  try {
    // First check if department is assigned to any employees
    const [assignedEmployees] = await db.query(
      'SELECT COUNT(*) as count FROM employees WHERE department_id = ?',
      [req.params.id]
    );

    if (assignedEmployees[0].count > 0) {
      return res.status(400).json({ 
        message: 'Cannot delete department as it is assigned to employees. Please reassign employees first.' 
      });
    }

    // If no employees are assigned, proceed with deletion
    await db.query(
      'DELETE FROM departments WHERE department_id = ?',
      [req.params.id]
    );
    
    res.json({ message: 'Department deleted successfully' });
  } catch (error) {
    console.error('Error deleting department:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all designations
router.get('/designations', auth, async (req, res) => {
  try {
    console.log('Fetching designations...');
    const [designations] = await db.query('SELECT * FROM designations ORDER BY designation_name');
    // console.log('Found designations:', designations);
    res.json(designations);
  } catch (error) {
    console.error('Error fetching designations:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add new designation
router.post('/designations', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Only admin or HR can add designations' });
  }

  try {
    const { designation_name } = req.body;
    await db.query(
      'INSERT INTO designations (designation_name) VALUES (?)',
      [designation_name]
    );
    res.status(201).json({ message: 'Designation added successfully' });
  } catch (error) {
    console.error('Error adding designation:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update designation
router.put('/designations/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Only admin or HR can update designations' });
  }

  try {
    const { designation_name } = req.body;
    await db.query(
      'UPDATE designations SET designation_name = ? WHERE designation_id = ?',
      [designation_name, req.params.id]
    );
    res.json({ 
      message: 'Designation updated successfully',
      designation_name: designation_name
    });
  } catch (error) {
    console.error('Error updating designation:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete designation
router.delete('/designations/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Only admin or HR can delete designations' });
  }

  try {
    // First check if designation is assigned to any employees
    const [assignedEmployees] = await db.query(
      'SELECT COUNT(*) as count FROM employees WHERE designation_id = ?',
      [req.params.id]
    );

    if (assignedEmployees[0].count > 0) {
      return res.status(400).json({ 
        message: 'Cannot delete designation as it is assigned to employees. Please reassign employees first.' 
      });
    }

    // If no employees are assigned, proceed with deletion
    await db.query(
      'DELETE FROM designations WHERE designation_id = ?',
      [req.params.id]
    );
    
    res.json({ message: 'Designation deleted successfully' });
  } catch (error) {
    console.error('Error deleting designation:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all locations
router.get('/locations', auth, async (req, res) => {
  try {
    console.log('Fetching locations...');
    const [locations] = await db.query('SELECT * FROM locations ORDER BY location_name');
    // console.log('Found locations:', locations);
    res.json(locations);
  } catch (error) {
    console.error('Error fetching locations:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add new location
router.post('/locations', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Only admin or HR can add locations' });
  }

  try {
    const { location_name } = req.body;
    await db.query(
      'INSERT INTO locations (location_name) VALUES (?)',
      [location_name]
    );
    res.status(201).json({ message: 'Location added successfully' });
  } catch (error) {
    console.error('Error adding location:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update location
router.put('/locations/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Only admin or HR can update locations' });
  }

  try {
    const { location_name } = req.body;
    await db.query(
      'UPDATE locations SET location_name = ? WHERE location_id = ?',
      [location_name, req.params.id]
    );
    res.json({ 
      message: 'Location updated successfully',
      location_name: location_name
    });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete location
router.delete('/locations/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Only admin or HR can delete locations' });
  }

  try {
    // First check if location is assigned to any employees
    const [assignedEmployees] = await db.query(
      'SELECT COUNT(*) as count FROM employees WHERE location_id = ?',
      [req.params.id]
    );

    if (assignedEmployees[0].count > 0) {
      return res.status(400).json({ 
        message: 'Cannot delete location as it is assigned to employees. Please reassign employees first.' 
      });
    }

    // If no employees are assigned, proceed with deletion
    await db.query(
      'DELETE FROM locations WHERE location_id = ?',
      [req.params.id]
    );
    
    res.json({ message: 'Location deleted successfully' });
  } catch (error) {
    console.error('Error deleting location:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get employee details
router.get('/:empId', auth, async (req, res) => {
  try {
    const [employees] = await db.query(
      `SELECT 
        e.*,
        d.department_name,
        des.designation_name,
        l.location_name,
        u.role,
        u.status,
        e.first_reporting_manager_emp_code,
        rm1.emp_id AS first_reporting_manager_id,
        CONCAT(rm1.emp_code, ' - ', rm1.first_name, ' ', IFNULL(rm1.middle_name, ''), ' ', rm1.last_name) AS first_reporting_manager_name,
        e.second_reporting_manager_emp_code,
        rm2.emp_id AS second_reporting_manager_id,
        CONCAT(rm2.emp_code, ' - ', rm2.first_name, ' ', IFNULL(rm2.middle_name, ''), ' ', rm2.last_name) AS second_reporting_manager_name
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.department_id
       LEFT JOIN designations des ON e.designation_id = des.designation_id
       LEFT JOIN locations l ON e.location_id = l.location_id
       LEFT JOIN users u ON e.emp_id = u.emp_id
       LEFT JOIN employees rm1 ON e.first_reporting_manager_emp_code = rm1.emp_code
       LEFT JOIN employees rm2 ON e.second_reporting_manager_emp_code = rm2.emp_code
       WHERE e.emp_id = ?`,
      [req.params.empId]
    );

    if (employees.length === 0) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Ensure reporting manager names are always present (N/A fallback)
    const emp = employees[0];
    emp.first_reporting_manager_name = emp.first_reporting_manager_name && emp.first_reporting_manager_id ? emp.first_reporting_manager_name.replace(/\s+/g, ' ').trim() : 'N/A';
    emp.second_reporting_manager_name = emp.second_reporting_manager_name && emp.second_reporting_manager_id ? emp.second_reporting_manager_name.replace(/\s+/g, ' ').trim() : 'N/A';

    res.json(emp);
  } catch (error) {
    console.error('Error fetching employee details:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add new employee (HR only)
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'hr' && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. HR or Admin role required.' });
  }

  let {
    emp_code,
    username,
    first_name,
    middle_name,
    last_name,
    email,
    mobile_number,
    designation_id,
    department_id,
    location_id,
    date_of_joining,
    category,
    gender,
    birth_of_date,
    first_reporting_manager_emp_code,
    second_reporting_manager_emp_code
  } = req.body;

  // Validate mandatory fields
  if (
    !emp_code ||
    !first_name ||
    !email ||
    !mobile_number ||
    !designation_id ||
    !department_id ||
    !location_id ||
    !date_of_joining ||
    !category ||
    !gender ||
    !birth_of_date ||
    !first_reporting_manager_emp_code ||
    !second_reporting_manager_emp_code
  ) {
    return res.status(400).json({ message: 'All fields are mandatory except middle name and last name.' });
  }

  // Always set username = email
  username = email;
  // Set full_name
  const full_name = [first_name, middle_name, last_name].filter(Boolean).join(' ');

  // Helper to format date to 'YYYY-MM-DD'
  function toMysqlDate(val) {
    if (!val) return null;
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    if (typeof val === 'number') {
      // Excel date serial number
      const excelEpoch = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(excelEpoch.getTime() + val * 24 * 60 * 60 * 1000);
      if (!isNaN(d)) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    }
    // Accept also DD/MM/YYYY and MM/DD/YYYY formats
    if (typeof val === 'string' && /^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/.test(val)) {
      const parts = val.split(/[\/\-]/);
      // Try DD/MM/YYYY first
      let d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      if (!isNaN(d)) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
      // Try MM/DD/YYYY
      d = new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
      if (!isNaN(d)) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    }
    if (val instanceof Date && !isNaN(val)) {
      const year = val.getFullYear();
      const month = String(val.getMonth() + 1).padStart(2, '0');
      const day = String(val.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    const d = new Date(val);
    if (!isNaN(d)) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    return null;
  }

  try {
    // Check for duplicate emp_code
    const [existingEmpCode] = await db.query(
      'SELECT emp_id FROM employees WHERE emp_code = ?',
      [emp_code]
    );
    if (existingEmpCode.length > 0) {
      return res.status(400).json({ message: 'Employee code already exists' });
    }

    // Check for duplicate username
    const [existingUsername] = await db.query(
      'SELECT emp_id FROM employees WHERE username = ?',
      [username]
    );
    if (existingUsername.length > 0) {
      return res.status(400).json({ message: 'Username already exists' });
    }

    // Check for duplicate email
    const [existingEmail] = await db.query(
      'SELECT emp_id FROM employees WHERE email = ?',
      [email]
    );
    if (existingEmail.length > 0) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    // Validate date_of_joining is not in the future and not before 1992-01-01
    if (date_of_joining) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const doj = new Date(date_of_joining);
      doj.setHours(0, 0, 0, 0);
      const minDate = new Date('1992-01-01');
      minDate.setHours(0, 0, 0, 0);
      if (doj > today) {
        return res.status(400).json({ message: 'Date of joining cannot be in the future' });
      }
      if (doj < minDate) {
        return res.status(400).json({ message: 'Company is not established at that time' });
      }
    }

    // Insert new employee only, without creating user
    const [result] = await db.query(
      `INSERT INTO employees (
        emp_code,
        username,
        first_name,
        middle_name,
        last_name,
        full_name,
        email,
        mobile_number,
        designation_id,
        department_id,
        location_id,
        date_of_joining,
        category,
        gender,
        birth_of_date,
        first_reporting_manager_emp_code,
        second_reporting_manager_emp_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        emp_code,
        username,
        first_name,
        middle_name || null,
        last_name,
        full_name,
        email,
        mobile_number,
        designation_id,
        department_id,
        location_id,
        date_of_joining || null,
        category || null,
        gender || null,
        toMysqlDate(birth_of_date) || null, // <-- fix here
        first_reporting_manager_emp_code || null,
        second_reporting_manager_emp_code || null
      ]
    );

    // After employee is added, generate activation token
    const empId = result.insertId;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24 hours

    await db.query(
      'INSERT INTO user_activation_tokens (emp_id, token, expires_at) VALUES (?, ?, ?)',
      [empId, token, expiresAt]
    );

    // Send activation email
    const activationLink = `${process.env.FRONTEND_URL}/activate-account?token=${token}`;
    try {
      await EmailService.sendEmail(
        email,
        'Activate your Expense Tracker Account',
        `<div style="font-family: Arial, sans-serif; background: #f8f9fa; padding: 32px;">
          <h2 style="color: #1976d2;">Welcome to Expense Tracker, ${first_name}!</h2>
          <p>Your employee account has been created. To activate your user account and set your password, please click the button below:</p>
          <p style="margin: 24px 0;">
            <a href="${activationLink}" style="background: #1976d2; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 1.1rem;">
              Activate Account
            </a>
          </p>
          <p>Your email: <b>${email}</b></p>
          <p>This link will expire in <b>24 hours</b>.</p>
          <hr style="margin: 32px 0;">
          <p style="color: #888; font-size: 0.95rem;">If you did not request this, please ignore this email or contact HR.</p>
        </div>`
      );
      console.log(`Activation email sent to ${email} for employee ${emp_code}`);
    } catch (emailError) {
      console.error('Error sending activation email:', emailError);
      // Optionally: continue, but notify admin
    }

    res.status(201).json({ message: 'Employee added successfully and activation email sent.' });
  } catch (error) {
    console.error('Error adding employee:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// New route for admin/hr to update last employment date
router.put('/:empId/terminate', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Access denied. Admin or HR role required.' });
  }

  const { last_employment_date, new_first_manager, new_second_manager, inactive_reason } = req.body; // <-- get inactive_reason

  try {
    await db.query('START TRANSACTION');

    // Get employee code before termination
    const [employee] = await db.query(
      'SELECT emp_code FROM employees WHERE emp_id = ?',
      [req.params.empId]
    );

    if (employee.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ message: 'Employee not found' });
    }

    const empCode = employee[0].emp_code;

    // Update reportees' managers if provided
    if (new_first_manager || new_second_manager) {
      await db.query(`
        UPDATE employees 
        SET 
          first_reporting_manager_emp_code = CASE 
            WHEN first_reporting_manager_emp_code = ? THEN ? 
            ELSE first_reporting_manager_emp_code 
          END,
          second_reporting_manager_emp_code = CASE 
            WHEN second_reporting_manager_emp_code = ? THEN ? 
            ELSE second_reporting_manager_emp_code 
          END
        WHERE first_reporting_manager_emp_code = ? 
        OR second_reporting_manager_emp_code = ?
      `, [
        empCode, new_first_manager,
        empCode, new_second_manager,
        empCode, empCode
      ]);
    }

    // Update the employee's last employment date
    await db.query(
      `UPDATE employees 
       SET last_employment_date = ?
       WHERE emp_id = ?`,
      [last_employment_date, req.params.empId]
    );

    // Update user status to inactive and set inactive_reason
    await db.query(
      `UPDATE users 
       SET status = 'inactive', inactive_reason = ?
       WHERE emp_id = ?`,
      [inactive_reason || 'terminated', req.params.empId] // <-- set reason
    );

    await db.query('COMMIT');
    
    res.json({ 
      message: 'Employee status updated and reportees reassigned successfully',
      status: 'inactive',
      last_employment_date: last_employment_date,
      inactive_reason: inactive_reason || 'terminated'
    });

  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Error in termination:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// New route for admin/hr to reactivate employee
router.put('/:empId/reactivate', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Access denied. Admin or HR role required.' });
  }

  try {
    await db.query('START TRANSACTION');

    // Clear last employment date and reactivate user
    await db.query(
      `UPDATE employees 
       SET last_employment_date = NULL
       WHERE emp_id = ?`,
      [req.params.empId]
    );

    const [updateUser] = await db.query(
      `UPDATE users 
       SET status = 'active' 
       WHERE emp_id = ?`,
      [req.params.empId]
    );

    if (updateUser.affectedRows === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ message: 'User not found' });
    }

    await db.query('COMMIT');
    
    res.json({ 
      message: 'Employee reactivated successfully',
      status: 'active'
    });

  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Error in reactivation:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update employee (HR only)
router.put('/:empId', auth, async (req, res) => {
  if (req.user.role !== 'hr' && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. HR or Admin role required.' });
  }

  let {
    emp_code,
    username,
    first_name,
    middle_name,
    last_name,
    email,
    mobile_number,
    designation_id,
    department_id,
    location_id,
    date_of_joining,
    category,
    gender,
    birth_of_date,
    role,
    password,
    first_reporting_manager_emp_code,
    second_reporting_manager_emp_code,
    last_employment_date,
    inactive_reason, // <-- add this field
  } = req.body;

  username = email;
  const full_name = [first_name, middle_name, last_name].filter(Boolean).join(' ');

  // Helper to format date to 'YYYY-MM-DD'
  function toMysqlDate(val) {
    if (!val) return null;
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    if (typeof val === 'number') {
      // Excel date serial number
      const excelEpoch = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(excelEpoch.getTime() + val * 24 * 60 * 60 * 1000);
      if (!isNaN(d)) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    }
    // Accept also DD/MM/YYYY and MM/DD/YYYY formats
    if (typeof val === 'string' && /^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/.test(val)) {
      const parts = val.split(/[\/\-]/);
      // Try DD/MM/YYYY first
      let d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      if (!isNaN(d)) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
      // Try MM/DD/YYYY
      d = new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
      if (!isNaN(d)) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    }
    if (val instanceof Date && !isNaN(val)) {
      const year = val.getFullYear();
      const month = String(val.getMonth() + 1).padStart(2, '0');
      const day = String(val.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    const d = new Date(val);
    if (!isNaN(d)) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    return null;
  }

  // Fix mobile number: remove duplicate country code if present
  if (mobile_number) {
    // Remove all non-digit except leading '+'
    mobile_number = mobile_number.replace(/(undefined)+/g, '');
    // If country code is repeated, keep only one
    mobile_number = mobile_number.replace(/^(\+\d{1,3})\1/, '$1');
  }

  try {
    await db.query('START TRANSACTION');

    // Check for duplicates excluding current employee
    const [existingEmpCode] = await db.query(
      'SELECT emp_id FROM employees WHERE emp_code = ? AND emp_id != ?',
      [emp_code, req.params.empId]
    );
    if (existingEmpCode.length > 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ message: 'Employee code already exists' });
    }

    // --- ADD THIS BLOCK: Prevent updating emp_code if referenced as reporting manager ---
    // Get current emp_code for this emp_id
    const [currentEmp] = await db.query(
      'SELECT emp_code FROM employees WHERE emp_id = ?',
      [req.params.empId]
    );
    const currentEmpCode = currentEmp[0]?.emp_code;
    if (currentEmpCode && emp_code !== currentEmpCode) {
      // Check if current emp_code is referenced as a reporting manager
      const [referenced] = await db.query(
        `SELECT COUNT(*) as count FROM employees 
         WHERE first_reporting_manager_emp_code = ? OR second_reporting_manager_emp_code = ?`,
        [currentEmpCode, currentEmpCode]
      );
      if (referenced[0].count > 0) {
        await db.query('ROLLBACK');
        return res.status(400).json({ 
          message: 'Cannot change Employee Code because it is referenced as a reporting manager for other employees. Please update or remove those references first.'
        });
      }
    }
    // --- END BLOCK ---

    const [existingUsername] = await db.query(
      'SELECT emp_id FROM employees WHERE username = ? AND emp_id != ?',
      [username, req.params.empId]
    );
    if (existingUsername.length > 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ message: 'Username already exists' });
    }

    const [existingEmail] = await db.query(
      'SELECT emp_id FROM employees WHERE email = ? AND emp_id != ?',
      [email, req.params.empId]
    );
    if (existingEmail.length > 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ message: 'Email already exists' });
    }

    // Validate date_of_joining is not in the future and not before 1992-01-01
    if (date_of_joining) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const doj = new Date(date_of_joining);
      doj.setHours(0, 0, 0, 0);
      const minDate = new Date('1992-01-01');
      minDate.setHours(0, 0, 0, 0);
      if (doj > today) {
        await db.query('ROLLBACK');
        return res.status(400).json({ message: 'Date of joining cannot be in the future' });
      }
      if (doj < minDate) {
        await db.query('ROLLBACK');
        return res.status(400).json({ message: 'Company is not established at that time' });
      }
    }

    // Update employee info
    await db.query(
      `UPDATE employees 
       SET emp_code = ?,
           username = ?,
           first_name = ?,
           middle_name = ?,
           last_name = ?,
           full_name = ?,
           email = ?,
           mobile_number = ?,
           designation_id = ?,
           department_id = ?,
           location_id = ?,
           date_of_joining = ?,
           last_employment_date = ?,
           category = ?,
           gender = ?,
           birth_of_date = ?,
           first_reporting_manager_emp_code = ?,
           second_reporting_manager_emp_code = ?
       WHERE emp_id = ?`,
      [
        emp_code,
        username,
        first_name,
        middle_name || null,
        last_name,
        full_name,
        email,
        mobile_number, // <-- fixed value
        designation_id,
        department_id,
        location_id,
        toMysqlDate(date_of_joining) || null,
        toMysqlDate(last_employment_date) || null,
        category || null,
        gender || null,
        toMysqlDate(birth_of_date) || null,
        first_reporting_manager_emp_code || null,
        second_reporting_manager_emp_code || null,
        req.params.empId
      ]
    );

    // Update user info
    const userUpdates = [];
    const userValues = [];
    userUpdates.push('username = ?');
    userValues.push(username);
    userUpdates.push('email = ?');
    userValues.push(email);
    if (typeof inactive_reason !== 'undefined') {
      userUpdates.push('inactive_reason = ?');
      userValues.push(inactive_reason || null);
    }
    userValues.push(req.params.empId);

    await db.query(
      `UPDATE users 
       SET ${userUpdates.join(', ')}
       WHERE emp_id = ?`,
      userValues
    );

    // If admin is updating role or password
    if (req.user.role === 'admin' || req.user.role === 'hr') {
      const updates = [];
      const values = [];

      if (role) {
        updates.push('role = ?');
        values.push(role);
      }

      if (password) {
        // Check if password is already hashed
        if (!password.startsWith('$2')) {
          // If not hashed, hash it
          const salt = await bcrypt.genSalt(10);
          const hashedPassword = await bcrypt.hash(password, salt);
          updates.push('password = ?');
          values.push(hashedPassword);
        } else {
          updates.push('password = ?');
          values.push(password);
        }
      }

      if (updates.length > 0) {
        values.push(req.params.empId);
        await db.query(
          `UPDATE users 
           SET ${updates.join(', ')}
           WHERE emp_id = ?`,
          values
        );
      }
    }

    await db.query('COMMIT');
    res.json({ message: 'Employee updated successfully' });
  } catch (error) {
    await db.query('ROLLBACK');
    if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_ROW_IS_REFERENCED_2') {
      await db.query('SET FOREIGN_KEY_CHECKS = 1');
    }
    console.error('Error updating employee:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Bulk upload employees (CSV/XLSX)
router.post('/upload-csv', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  // Define toMysqlDate inside this endpoint
  function toMysqlDate(val) {
    if (!val) return null;
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    if (typeof val === 'number') {
      // Excel date serial number
      const excelEpoch = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(excelEpoch.getTime() + val * 24 * 60 * 60 * 1000);
      if (!isNaN(d)) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    }
    // Accept also DD/MM/YYYY and MM/DD/YYYY formats
    if (typeof val === 'string' && /^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/.test(val)) {
      const parts = val.split(/[\/\-]/);
      // Try DD/MM/YYYY first
      let d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      if (!isNaN(d)) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
      // Try MM/DD/YYYY
      d = new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
      if (!isNaN(d)) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    }
    if (val instanceof Date && !isNaN(val)) {
      const year = val.getFullYear();
      const month = String(val.getMonth() + 1).padStart(2, '0');
      const day = String(val.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    const d = new Date(val);
    if (!isNaN(d)) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    return null;
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
        // Username and email must be the same
        if (record.username !== record.email) {
          errors.push(`Username and email must be the same for employee code ${record.emp_code}`);
          continue;
        }

        // Required fields (middle_name and last_name optional, reporting managers optional)
        const requiredFields = [
          'emp_code', 
          'username', 
          'first_name', 
          'full_name',   
          'email', 
          'mobile_number',
          'designation_id',
          'department_id',
          'location_id',
          'date_of_joining',
          'category',
          'gender',
          'birth_of_date'
        ];
        
        const missingFields = requiredFields.filter(field => !record[field]);
        if (missingFields.length > 0) {
          errors.push(`Missing mandatory fields for employee ${record.emp_code || 'unknown'}: ${missingFields.join(', ')}`);
          continue;
        }

        // Validate that IDs exist in their respective tables
        const [designationExists] = await db.query('SELECT designation_id FROM designations WHERE designation_id = ?', [record.designation_id]);
        if (designationExists.length === 0) {
          errors.push(`Invalid designation_id for employee ${record.emp_code}: ${record.designation_id}`);
          continue;
        }

        const [departmentExists] = await db.query('SELECT department_id FROM departments WHERE department_id = ?', [record.department_id]);
        if (departmentExists.length === 0) {
          errors.push(`Invalid department_id for employee ${record.emp_code}: ${record.department_id}`);
          continue;
        }

        const [locationExists] = await db.query('SELECT location_id FROM locations WHERE location_id = ?', [record.location_id]);
        if (locationExists.length === 0) {
          errors.push(`Invalid location_id for employee ${record.emp_code}: ${record.location_id}`);
          continue;
        }

        // Check for existing employee
        const [existingEmployee] = await db.query(
          'SELECT emp_id FROM employees WHERE emp_code = ? OR username = ? OR email = ?',
          [record.emp_code, record.username, record.email]
        );
        if (existingEmployee.length > 0) {
          errors.push(`Employee with code ${record.emp_code} or username ${record.username} or email ${record.email} already exists`);
          continue;
        }

        // Validate date_of_joining and birth_of_date
        const mysqlDate = toMysqlDate(record.date_of_joining);
        if (!mysqlDate) {
          errors.push(`Error processing employee ${record.emp_code || 'unknown'}: Incorrect date value for date_of_joining`);
          continue;
        }
        const mysqlBirthDate = toMysqlDate(record.birth_of_date);

        // Ensure last_name is never undefined/null for DB (set to empty string if missing)
        const lastNameValue = typeof record.last_name === 'undefined' || record.last_name === null ? '' : record.last_name;

        // Insert employee with all fields (middle_name and last_name optional, reporting managers optional)
        const [insertResult] = await db.query(
          `INSERT INTO employees (
            emp_code,
            username,
            first_name,
            middle_name,
            last_name,
            full_name,
            email,
            mobile_number,
            designation_id,
            department_id,
            location_id,
            date_of_joining,
            category,
            gender,
            birth_of_date,
            first_reporting_manager_emp_code,
            second_reporting_manager_emp_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.emp_code,
            record.username,
            record.first_name,
            record.middle_name || null,
            lastNameValue,
            record.full_name || [record.first_name, record.middle_name, lastNameValue].filter(Boolean).join(' '),
            record.email,
            record.mobile_number,
            record.designation_id,
            record.department_id,
            record.location_id,
            mysqlDate,
            record.category || null,
            record.gender || null,
            mysqlBirthDate || null,
            record.first_reporting_manager_emp_code || null,
            record.second_reporting_manager_emp_code || null
          ]
        );

        // Send activation email (same as manual add)
        try {
          const empId = insertResult.insertId;
          const token = crypto.randomBytes(32).toString('hex');
          const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24 hours

          await db.query(
            'INSERT INTO user_activation_tokens (emp_id, token, expires_at) VALUES (?, ?, ?)',
            [empId, token, expiresAt]
          );

          const activationLink = `${process.env.FRONTEND_URL}/activate-account?token=${token}`;
          await EmailService.sendEmail(
            record.email,
            'Activate your Expense Tracker Account',
            `<div style="font-family: Arial, sans-serif; background: #f8f9fa; padding: 32px;">
              <h2 style="color: #1976d2;">Welcome to Expense Tracker, ${record.first_name}!</h2>
              <p>Your employee account has been created. To activate your user account and set your password, please click the button below:</p>
              <p style="margin: 24px 0;">
                <a href="${activationLink}" style="background: #1976d2; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 1.1rem;">
                  Activate Account
                </a>
              </p>
              <p>Your email: <b>${record.email}</b></p>
              <p>This link will expire in <b>24 hours</b>.</p>
              <hr style="margin: 32px 0;">
              <p style="color: #888; font-size: 0.95rem;">If you did not request this, please ignore this email or contact HR.</p>
            </div>`
          );
        } catch (emailError) {
          errors.push(`Employee ${record.emp_code}: Error sending activation email (${emailError.message})`);
        }

        results.push({
          emp_code: record.emp_code,
          status: 'success',
          message: 'Employee added successfully'
        });

      } catch (error) {
        errors.push(`Error processing employee ${record.emp_code || 'unknown'}: ${error.message}`);
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

// New endpoint to get employees reporting to a manager
router.get('/reporting-to/:empCode', auth, async (req, res) => {
  try {
    const [reportees] = await db.query(`
      SELECT e.*, d.designation_name 
      FROM employees e
      LEFT JOIN designations d ON e.designation_id = d.designation_id
      WHERE e.first_reporting_manager_emp_code = ?
      OR e.second_reporting_manager_emp_code = ?
    `, [req.params.empCode, req.params.empCode]);
    
    res.json(reportees);
  } catch (error) {
    console.error('Error fetching reportees:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /all endpoint already returns inactive_reason for each employee

// Get all coordinator-department mappings
router.get('/coordinator-departments', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT cd.id, cd.coordinator_emp_id, cd.department_id,
        e.emp_code AS coordinator_emp_code,
        CONCAT(e.first_name, ' ', IFNULL(e.middle_name, ''), ' ', e.last_name) AS coordinator_name,
        d.department_name
      FROM coordinator_departments cd
      JOIN employees e ON cd.coordinator_emp_id = e.emp_id
      JOIN departments d ON cd.department_id = d.department_id
      ORDER BY cd.id
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching mappings' });
  }
});

// Add new coordinator-department mapping
router.post('/coordinator-departments', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Access denied.' });
  }
  const { coordinator_emp_id, department_id } = req.body;
  try {
    await db.query(
      'INSERT INTO coordinator_departments (coordinator_emp_id, department_id) VALUES (?, ?)',
      [coordinator_emp_id, department_id]
    );
    res.status(201).json({ message: 'Mapping added' });
  } catch (error) {
    res.status(500).json({ message: 'Error adding mapping' });
  }
});

// Update coordinator-department mapping (used for reassign on delete)
router.put('/coordinator-departments/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Access denied.' });
  }
  const { coordinator_emp_id, department_id } = req.body;
  try {
    await db.query(
      'UPDATE coordinator_departments SET coordinator_emp_id = ?, department_id = ? WHERE id = ?',
      [coordinator_emp_id, department_id, req.params.id]
    );
    res.json({ message: 'Coordinator and department updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error updating mapping' });
  }
});

// Delete coordinator-department mapping (disable direct delete, always require reassignment)
router.delete('/coordinator-departments/:id', auth, async (req, res) => {
  return res.status(400).json({ message: 'Direct delete is disabled. Please reassign coordinator instead.' });
});

// --- Password Reset Link Endpoint (ADMIN ONLY) ---
router.post('/admin/send-reset-password-link', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Only admin can send password reset links.' });
  }
  const { emp_id } = req.body;
  if (!emp_id) {
    return res.status(400).json({ message: 'emp_id is required.' });
  }
  try {
    // Get user email
    const [rows] = await db.query(
      `SELECT u.email, e.first_name FROM users u
       JOIN employees e ON u.emp_id = e.emp_id
       WHERE u.emp_id = ? LIMIT 1`, [emp_id]
    );
    if (!rows.length) {
      return res.status(404).json({ message: 'User not found.' });
    }
    const { email, first_name } = rows[0];

    // Generate reset token (store in DB, expires in 1 hour)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour

    // Store token in a new table or reuse user_activation_tokens for simplicity
    await db.query(
      'INSERT INTO user_activation_tokens (emp_id, token, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE token=?, expires_at=?',
      [emp_id, token, expiresAt, token, expiresAt]
    );

    // Send email with reset link
    const resetLink = `${process.env.FRONTEND_URL}/activate-account?token=${token}`;
    await EmailService.sendEmail(
      email,
      'Reset Your Expense Tracker Password',
      `<div style="font-family: Arial, sans-serif; background: #f8f9fa; padding: 32px;">
        <h2 style="color: #1976d2;">Password Reset Requested</h2>
        <p>Hello ${first_name || ''},</p>
        <p>An administrator has requested a password reset for your Expense Tracker account.</p>
        <p style="margin: 24px 0;">
          <a href="${resetLink}" style="background: #1976d2; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 1.1rem;">
            Set Password
          </a>
        </p>
        <p>Please click the button above to set your new password.</p>
        <p>If you did not request this, please contact your administrator.</p>
        <p>This link will expire in <b>1 hour</b>.</p>
        <hr style="margin: 32px 0;">
        <p style="color: #888; font-size: 0.95rem;">If you have any issues, please contact HR.</p>
      </div>`
    );

    res.json({ message: 'Password reset link sent.' });
  } catch (error) {
    console.error('Error sending reset password link:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add/Update tab_permissions for any user (admin only)
router.put('/:empId/tab-permissions', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Only admin can update tab permissions.' });
  }
  const { tab_permissions } = req.body;
  try {
    // Remove HR/Accounts-only restriction: allow for any user
    await db.query(
      'UPDATE users SET tab_permissions = ? WHERE emp_id = ?',
      [JSON.stringify(tab_permissions || []), req.params.empId]
    );
    res.json({ message: 'Tab permissions updated.' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Add this route to fetch employee by emp_code
router.get('/by-code/:emp_code', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT emp_code, first_name, middle_name, last_name FROM employees WHERE emp_code = ? LIMIT 1`,
      [req.params.emp_code]
    );
    if (!rows.length) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Upload profile image
router.post('/:empId/profile-image', auth, upload.single('profileImage'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  // Save path as uploads/images/...
  const imagePath = req.file.path.replace(/\\/g, '/');
  try {
    await db.query('UPDATE employees SET profile_image_path = ? WHERE emp_id = ?', [imagePath, req.params.empId]);
    res.json({ message: 'Profile image uploaded', profile_image_path: imagePath });
  } catch (error) {
    res.status(500).json({ message: 'Error uploading image' });
  }
});

// Delete profile image
router.delete('/:empId/profile-image', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT profile_image_path FROM employees WHERE emp_id = ?', [req.params.empId]);
    if (rows.length && rows[0].profile_image_path) {
      const fs = require('fs');
      if (fs.existsSync(rows[0].profile_image_path)) {
        fs.unlinkSync(rows[0].profile_image_path);
      }
    }
    await db.query('UPDATE employees SET profile_image_path = NULL WHERE emp_id = ?', [req.params.empId]);
    res.json({ message: 'Profile image deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting image' });
  }
});

// Bulk update reporting managers for existing employees
router.post('/bulk-update-reporting-managers', upload.single('file'), auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Access denied. Admin or HR role required.' });
  }
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  const results = [];
  const errors = [];

  try {
    let records = [];
    if (req.file.originalname.endsWith('.xlsx')) {
      const workbook = xlsx.readFile(req.file.path);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      records = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
    } else {
      const parser = fs.createReadStream(req.file.path)
        .pipe(parse({ columns: true, skip_empty_lines: true, trim: true }));
      for await (const record of parser) {
        records.push(record);
      }
    }

    for (const record of records) {
      const empCode = record.emp_code;
      const firstManager = record.first_reporting_manager_emp_code || null;
      const secondManager = record.second_reporting_manager_emp_code || null;
      if (!empCode) {
        errors.push('Missing emp_code in row');
        continue;
      }
      // Check if employee exists
      const [employees] = await db.query('SELECT emp_id FROM employees WHERE emp_code = ?', [empCode]);
      if (employees.length === 0) {
        errors.push(`Employee code not found: ${empCode}`);
        continue;
      }
      // Optionally: check if manager codes exist (skip if blank/null)
      let firstManagerExists = true;
      let secondManagerExists = true;
      if (firstManager) {
        const [fm] = await db.query('SELECT emp_id FROM employees WHERE emp_code = ?', [firstManager]);
        firstManagerExists = fm.length > 0;
      }
      if (secondManager) {
        const [sm] = await db.query('SELECT emp_id FROM employees WHERE emp_code = ?', [secondManager]);
        secondManagerExists = sm.length > 0;
      }
      if ((firstManager && !firstManagerExists) || (secondManager && !secondManagerExists)) {
        errors.push(`Manager code not found for employee ${empCode}`);
        continue;
      }
      // Update employee
      await db.query(
        `UPDATE employees SET first_reporting_manager_emp_code = ?, second_reporting_manager_emp_code = ? WHERE emp_code = ?`,
        [firstManager, secondManager, empCode]
      );
      results.push({ emp_code: empCode, status: 'success' });
    }
    fs.unlinkSync(req.file.path);
    res.json({
      message: 'Bulk reporting manager update completed',
      totalProcessed: results.length + errors.length,
      successCount: results.length,
      errorCount: errors.length,
      successRecords: results,
      errors: errors
    });
  } catch (error) {
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ message: 'Error processing file', error: error.message });
  }
});

module.exports = router;
