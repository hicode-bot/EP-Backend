const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const auth = require('../middleware/auth');

// Login route
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // First check if user exists
    const [users] = await db.query(
      `SELECT u.*, e.emp_code, e.first_name, e.last_name, 
              e.last_employment_date, e.email
       FROM users u
       JOIN employees e ON u.emp_id = e.emp_id
       WHERE u.username = ?`,
      [username]
    );

    if (users.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const user = users[0];

    // Check if status is already inactive
    if (user.status === 'inactive') {
      return res.status(401).json({ message: 'Your account is inactive. Please contact HR.' });
    }

    // Check if last_employment_date has passed
    if (user.last_employment_date && new Date(user.last_employment_date) <= new Date()) {
      // Update user status to inactive
      await db.query(
        `UPDATE users SET status = 'inactive' WHERE emp_id = ?`,
        [user.emp_id]
      );
      return res.status(401).json({ message: 'Your employment period has ended.' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    // Create and send token
    const token = jwt.sign(
      { 
        user_id: user.user_id,
        emp_id: user.emp_id,
        role: user.role 
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' } // Increased expiration to 7 days
    );

    res.json({
      token,
      user: {
        emp_id: user.emp_id,
        role: user.role,
        username: user.username,
        first_name: user.first_name,
        middle_name: user.middle_name,
        last_name: user.last_name,
        full_name: (user.first_name || user.middle_name || user.last_name)
          ? `${user.first_name || ''}${user.middle_name ? ' ' + user.middle_name : ''}${user.last_name ? ' ' + user.last_name : ''}`.replace(/\s+/g, ' ').trim()
          : user.full_name,
        email: user.email,
        status: user.status
      }
    });
  } catch (error) {
    // Provide a more informative error for debugging
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login. Please try again later.' });
  }
});

// Get current user route
router.get('/me', auth, async (req, res) => {
  try {
    const [users] = await db.query(
      `SELECT u.user_id, u.emp_id, u.role, u.status, u.tab_permissions,
              e.emp_code, e.username, e.first_name, e.middle_name, e.last_name, e.full_name, e.email,
              e.mobile_number, d.designation_name, dp.department_name,
              l.location_name, e.first_reporting_manager_emp_code,
              e.second_reporting_manager_emp_code,
              e.date_of_joining, e.category, e.gender, e.birth_of_date,
              CONCAT(rm1.first_name, ' ', IFNULL(rm1.middle_name, ''), ' ', rm1.last_name, ' (', rm1.emp_code, ')') as first_reporting_manager_name,
              CONCAT(rm2.first_name, ' ', IFNULL(rm2.middle_name, ''), ' ', rm2.last_name, ' (', rm2.emp_code, ')') as second_reporting_manager_name
       FROM users u
       JOIN employees e ON u.emp_id = e.emp_id
       LEFT JOIN designations d ON e.designation_id = d.designation_id
       LEFT JOIN departments dp ON e.department_id = dp.department_id
       LEFT JOIN locations l ON e.location_id = l.location_id
       LEFT JOIN employees rm1 ON e.first_reporting_manager_emp_code = rm1.emp_code
       LEFT JOIN employees rm2 ON e.second_reporting_manager_emp_code = rm2.emp_code
       WHERE u.user_id = ? AND u.status = 'active'`,
      [req.user.user_id]
    );

    if (!users.length) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = users[0];
    delete user.password;
    user.full_name = (user.first_name || user.middle_name || user.last_name)
      ? `${user.first_name || ''}${user.middle_name ? ' ' + user.middle_name : ''}${user.last_name ? ' ' + user.last_name : ''}`.replace(/\s+/g, ' ').trim()
      : user.full_name;
    // Add tab_permissions to response (parse if JSON)
    if (user.tab_permissions && typeof user.tab_permissions === 'string') {
      try { user.tab_permissions = JSON.parse(user.tab_permissions); } catch { }
    }
    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add new route for changing password
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Get user's current password
    const [users] = await db.query(
      'SELECT password FROM users WHERE user_id = ?',
      [req.user.user_id]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, users[0].password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update password
    await db.query(
      'UPDATE users SET password = ? WHERE user_id = ?',
      [hashedPassword, req.user.user_id]
    );

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add: Send password reset link (user self-service)
router.post('/send-reset-password-link', async (req, res) => {
  try {
    const { email_or_username } = req.body;
    if (!email_or_username) {
      return res.status(400).json({ message: 'Email or username is required.' });
    }
    // Find user by email or username
    const [users] = await db.query(
      `SELECT u.user_id, u.emp_id, u.email, u.username, e.first_name, e.last_name FROM users u JOIN employees e ON u.emp_id = e.emp_id WHERE u.email = ? OR u.username = ?`,
      [email_or_username, email_or_username]
    );
    if (!users.length) {
      // Always return success for security
      return res.json({ message: 'If your account exists, a reset link has been sent to your email.' });
    }
    const user = users[0];
    // Generate a secure token (expires in 1 hour)
    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    // Save token in user_activation_tokens (not password_reset_tokens)
    await db.query(
      `INSERT INTO user_activation_tokens (emp_id, token, expires_at, used) VALUES (?, ?, ?, 0)`,
      [user.emp_id, token, expiresAt]
    );
    // Send email with reset link
    const resetUrl = `${process.env.FRONTEND_URL}/activate-account?token=${token}`;
    const subject = 'Reset your Expense Tracker password';
    const html = `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; background: #f6f8fa; padding: 32px 0;">
        <div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(25,118,210,0.08); padding: 32px 32px 24px 32px;">
          <h2 style="color: #1976d2; font-size: 1.6rem; font-weight: 700; margin-bottom: 12px; letter-spacing: 0.5px;">Expense Tracker Password Reset</h2>
          <p style="font-size:16px; color:#222; margin-bottom: 8px;">Dear <b>${user.first_name || user.username}</b>,</p>
          <p style="font-size:15px; color:#333; margin-bottom: 8px;">We received a request to reset your password for your Expense Tracker account.</p>
          <p style="font-size:15px; color:#333; margin-bottom: 24px;">To proceed, please use the button below. This link will expire in <b>1 hour</b> for your security.</p>
          <div style="text-align:center; margin:32px 0;">
            <a href="${resetUrl}" style="display:inline-block; padding:14px 32px; background:#1976d2; color:#fff; font-size:17px; font-weight:600; border-radius:6px; text-decoration:none;">Reset Password</a>
          </div>
          <p style="font-size:14px; color:#666; margin-bottom: 0;">If you did not request this password reset, you can safely ignore this email. Your account will remain secure.</p>
          <p style="font-size:14px; color:#888; margin-top:32px;">Best regards,<br><b>Expense Tracker Team</b></p>
        </div>
        <div style="text-align:center; color:#bbb; font-size:12px; margin-top:24px;">&copy; ${new Date().getFullYear()} Expense Tracker</div>
      </div>
    `;
    const EmailService = require('../services/emailService');
    await EmailService.sendEmail(user.email, subject, html);
    res.json({ message: 'If your account exists, a reset link has been sent to your email.' });
  } catch (error) {
    console.error('Error sending reset link:', error);
    res.status(500).json({ message: 'Failed to send reset link.' });
  }
});

// Add: Reset password using token (for self-service reset)
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ message: 'Token and new password are required.' });
    }
    // Find the reset token and check if it's valid and not used/expired (in user_activation_tokens)
    const [rows] = await db.query(
      'SELECT * FROM user_activation_tokens WHERE token = ? AND expires_at > NOW() AND used = FALSE LIMIT 1',
      [token]
    );
    if (!rows.length) {
      return res.status(400).json({ message: 'Invalid or expired token.' });
    }
    const resetToken = rows[0];
    // Hash the new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    // Update the user's password in the users table (ensure correct table and field)
    const [userUpdateResult] = await db.query(
      'UPDATE users SET password = ? WHERE emp_id = ?',
      [hashedPassword, resetToken.emp_id]
    );
    // Mark the token as used
    await db.query(
      'UPDATE user_activation_tokens SET used = TRUE WHERE id = ?',
      [resetToken.id]
    );
    // Check if user password was actually updated
    if (userUpdateResult.affectedRows === 0) {
      return res.status(400).json({ message: 'User not found for password reset.' });
    }
    return res.json({ message: 'Password has been reset successfully.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ message: 'Server error. Please try again later.' });
  }
});

module.exports = router;
