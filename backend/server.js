require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const authRoutes = require('./routes/auth');
const expenseRoutes = require('./routes/expenses');
const employeeRoutes = require('./routes/employees');
const adminRoutes = require('./routes/admin');
const allowanceRoutes = require('./routes/allowance');

const auth = require('./middleware/auth');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();

// Remove or restrict debug logs in production
function devLog(...args) {
  if (process.env.NODE_ENV !== 'production') {
    console.log(...args);
  }
}

// Use only the cors package, with correct config
app.use(cors({
  origin: [process.env.FRONTEND_URL],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-jwt-token'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
}));

// Ensure CORS preflight requests are handled for all routes
app.options('*', cors({
  origin: [process.env.FRONTEND_URL],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-jwt-token'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
}));

app.use(express.json());

// Database connection
const db = mysql.createConnection({
  host: process.env.DB_HOST ,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD ,
  database: process.env.DB_NAME
});

db.connect((err) => {
  if (err) {
    console.error('Error connecting to database:', err);
    return;
  }
  devLog('Connected to MySQL database');
});

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    let folder = 'profile_images';
    if (file.mimetype === 'application/pdf') folder = 'pdfs';
    return {
      folder: folder,
      allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
      public_id: Date.now() + '-' + file.originalname.replace(/\s+/g, '_')
    };
  }
});

const upload = multer({ storage: storage });

// Register route handlers
app.use('/api/auth', authRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/allowance-rates', allowanceRoutes);

// Health check route for root
app.get('/', (req, res) => {
  res.send('API is running');
});

// Submit expense form
app.post('/api/expenses/submit', auth, upload.fields([
  { name: 'travelReceipt', maxCount: 1 }
]), (req, res) => {
  const expenseData = req.body;
  const files = req.files;

  // Begin transaction
  db.beginTransaction(err => {
    if (err) {
      return res.status(500).json({ error: 'Transaction error' });
    }

    // Use Cloudinary URL for travel_receipt_path
    const travelReceiptUrl = files.travelReceipt ? files.travelReceipt[0].path || files.travelReceipt[0].url : null;

    // Insert into expense_form table
    const expenseQuery = `
      INSERT INTO expense_form (
        emp_id, food_scope, 
        project_id, period_of_stay_from, period_of_stay_to,
        date_of_journey_going_from, date_of_journey_going_to,
        date_of_return_journey_from, date_of_return_journey_to,
        claim_amount,
        travel_receipt_path, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`;
    db.query(expenseQuery, [
      expenseData.emp_id,
      expenseData.food_scope,
      expenseData.project_id,
      expenseData.period_of_stay_from,
      expenseData.period_of_stay_to,
      expenseData.date_of_journey_going_from,
      expenseData.date_of_journey_going_to,
      expenseData.date_of_return_journey_from,
      expenseData.date_of_return_journey_to,
      expenseData.claim_amount,
      travelReceiptUrl
    ], (err, result) => {
      if (err) {
        return db.rollback(() => {
          res.status(500).json({ error: 'Error inserting expense data' });
        });
      }
      const expenseId = result.insertId;

      // Insert travel data
      const travelData = JSON.parse(expenseData.travel_data);
      const travelValues = travelData.map(travel => [
        expenseId,
        expenseData.emp_id,
        travel.travel_date,
        travel.from_location,
        travel.to_location,
        travel.mode_of_transport,
        travel.fare_amount
      ]);

      const travelQuery = `
        INSERT INTO travel_data (
          expense_id, emp_id, travel_date, from_location, to_location,
          mode_of_transport, fare_amount) VALUES ?`;
      db.query(travelQuery, [travelValues], (err) => {
        if (err) {
          return db.rollback(() => {
            res.status(500).json({ error: 'Error inserting travel data' });
          });
        }

        // Commit transaction
        db.commit(err => {
          if (err) {
            return db.rollback(() => {
              res.status(500).json({ error: 'Error committing transaction' });
            });
          }
          res.json({ message: 'Expense submitted successfully', expenseId });
        });
      });
    });
  });
});

// Search projects
app.get('/api/expenses/projects/search', auth, (req, res) => {
  const query = req.query.query;
  const searchQuery = `
    SELECT * FROM projects WHERE project_code LIKE ? OR project_name LIKE ?`;
  db.query(searchQuery, [`%${query}%`, `%${query}%`], (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  // Improved error logging for debugging
  if (process.env.NODE_ENV !== 'production') {
    console.error('Error:', err);
    if (err && err.stack) console.error(err.stack);
  }
  res.status(500).json({ message: 'Something broke!', error: err && err.message ? err.message : err });
});

// Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});