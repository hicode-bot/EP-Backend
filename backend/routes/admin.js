const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const auth = require('../middleware/auth');
const EmailService = require('../services/emailService'); // <-- Add this import

// Get employees without user accounts
router.get('/employees-without-users', auth, async (req, res) => {
  try {
    // Modified to get all employees
    const [employees] = await db.query(`
      SELECT e.*, u.user_id, u.role
      FROM employees e
      LEFT JOIN users u ON e.emp_id = u.emp_id
      ORDER BY e.first_name, e.last_name
    `);
    
    res.json(employees);
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create new user
router.post('/users', auth, async (req, res) => {
  // Allow both admin and hr roles
  if (req.user.role !== 'admin' && req.user.role !== 'hr') {
    return res.status(403).json({ message: 'Access denied. Admin or HR role required.' });
  }

  const { emp_id, password, role } = req.body;

  try {
    // First check if user already exists
    const [existingUser] = await db.query(
      'SELECT * FROM users WHERE emp_id = ?',
      [emp_id]
    );

    if (existingUser.length > 0) {
      return res.status(400).json({ message: 'User already exists for this employee' });
    }

    // Get employee details
    const [employee] = await db.query(
      'SELECT username, email FROM employees WHERE emp_id = ?',
      [emp_id]
    );

    if (employee.length === 0) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Insert new user
    const [result] = await db.query(
      `INSERT INTO users (emp_id, username, email, password, role, status) 
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [emp_id, employee[0].username, employee[0].email, hashedPassword, role]
    );

    res.status(201).json({ message: 'User created successfully' });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ message: 'Error creating user' });
  }
});

// Activate user via token (called from frontend)
router.post('/activate-user', async (req, res) => {
  const { token, password } = req.body;
  try {
    // Password validation: min 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 special char
    if (
      !password ||
      password.length < 8 ||
      !/[A-Z]/.test(password) ||
      !/[a-z]/.test(password) ||
      !/[0-9]/.test(password) ||
      !/[^A-Za-z0-9]/.test(password)
    ) {
      return res.status(400).json({
        message:
          'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.'
      });
    }

    // Find token regardless of usage
    const [rows] = await db.query(
      'SELECT * FROM user_activation_tokens WHERE token = ?',
      [token]
    );
    if (!rows.length) {
      // If token not found, return generic success (do nothing)
      return res.json({ message: 'Account activated successfully.' });
    }
    const activation = rows[0];
    if (activation.used) {
      // If token already used, allow password reset if user exists
      const [existingUser] = await db.query('SELECT * FROM users WHERE emp_id = ?', [activation.emp_id]);
      if (existingUser.length > 0) {
        // Hash password and update
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        await db.query('UPDATE users SET password = ? WHERE emp_id = ?', [hashedPassword, activation.emp_id]);
        return res.json({ message: 'Password updated successfully. You can now log in.' });
      }
      // If user does not exist, show error
      return res.status(400).json({ message: 'Account already activated. Please log in.' });
    }
    if (new Date(activation.expires_at) < new Date()) {
      // Show error if token is expired
      return res.status(400).json({ message: 'Invalid or expired activation link.' });
    }

    // Check if user already exists for this employee
    const [existingUser] = await db.query('SELECT * FROM users WHERE emp_id = ?', [activation.emp_id]);
    if (existingUser.length > 0) {
      // Instead of blocking, allow password reset
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      await db.query('UPDATE users SET password = ? WHERE emp_id = ?', [hashedPassword, activation.emp_id]);
      // Mark token as used
      await db.query('UPDATE user_activation_tokens SET used = TRUE WHERE id = ?', [activation.id]);
      return res.json({ message: 'Password updated successfully. You can now log in.' });
    }

    // Get employee info
    const [employees] = await db.query('SELECT * FROM employees WHERE emp_id = ?', [activation.emp_id]);
    if (!employees.length) {
      return res.status(404).json({ message: 'Employee not found.' });
    }
    const employee = employees[0];

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user account with default role 'user'
    await db.query(
      `INSERT INTO users (emp_id, username, email, password, role, status) 
       VALUES (?, ?, ?, ?, 'user', 'active')`,
      [employee.emp_id, employee.username, employee.email, hashedPassword]
    );

    // Mark token as used
    await db.query('UPDATE user_activation_tokens SET used = TRUE WHERE id = ?', [activation.id]);

    // Send confirmation email
    await EmailService.sendEmail(
      employee.email,
      'Your Expense Tracker account is activated',
      `<p>Hello ${employee.first_name},</p>
       <p>Your user account has been activated. You can now log in using your email: ${employee.email}</p>`
    );

    res.json({ message: 'Account activated successfully.' });
  } catch (error) {
    console.error('Activation error:', error);
    res.status(500).json({ message: 'Server error during activation.' });
  }
});

module.exports = router;
