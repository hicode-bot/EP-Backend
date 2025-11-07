const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false, // TLS for port 587
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Verify connection and log errors
transporter.verify(function(error, success) {
  if (error) {
    console.error('Outlook SMTP error:', error);
  } else {
    console.log('Outlook SMTP server is ready to send messages');
  }
});

module.exports = transporter;
