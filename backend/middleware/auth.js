const jwt = require('jsonwebtoken');
const db = require('../config/db');

const STATIC_TOKEN = '35d854a97f22d7b32ddd279642f22586a62a4788ae4f9850abe342875244862a';

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '') || 
                  req.header('x-jwt-token');
    
    if (!token) {
      return res.status(401).json({ message: 'No auth token found' });
    }

    // Check for static token first
    if (token === STATIC_TOKEN) {
      // For static token, set a default user context
      req.user = {
        user_id: 1,  // Default user ID
        role: 'admin',  // Default role
        emp_id: 1  // Default employee ID
      };
      return next();
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ message: 'Session expired. Please log in again.' });
      }
      return res.status(401).json({ message: 'Invalid authentication' });
    }

    // Check user status and last employment date in a single query
    const [users] = await db.query(
      `SELECT u.*, e.last_employment_date 
       FROM users u
       JOIN employees e ON u.emp_id = e.emp_id
       WHERE u.user_id = ? AND (
         u.status = 'active' AND (
           e.last_employment_date IS NULL OR 
           e.last_employment_date > CURDATE()
         )
       )`,
      [decoded.user_id]
    );

    if (!users.length) {
      return res.status(401).json({ 
        message: 'User is inactive or employment has been terminated' 
      });
    }

    req.user = users[0];
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ message: 'Invalid authentication' });
  }
};

module.exports = auth;
