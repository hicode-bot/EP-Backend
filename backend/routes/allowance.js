const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

// Get all allowance rates
router.get('/', auth, async (req, res) => {
  try {
    const [rates] = await db.query(
      'SELECT * FROM allowance_rates ORDER BY designation_id, scope'
    );
    res.json(rates);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add new allowance rate
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'hr' && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Not authorized' });
  }

  const { designation_id, scope, amount } = req.body;
  try {
    const [result] = await db.query(
      'INSERT INTO allowance_rates (designation_id, scope, amount) VALUES (?, ?, ?)',
      [designation_id, scope, amount]
    );
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ message: 'An allowance rate already exists for this designation and scope' });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
});

// Update allowance rate
router.put('/:id', auth, async (req, res) => {
  if (req.user.role !== 'hr' && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Not authorized' });
  }

  const { designation_id, scope, amount } = req.body;
  try {
    await db.query(
      'UPDATE allowance_rates SET designation_id = ?, scope = ?, amount = ? WHERE id = ?',
      [designation_id, scope, amount, req.params.id]
    );
    res.json({ message: 'Updated successfully' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ message: 'An allowance rate already exists for this designation and scope' });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
});

// Delete allowance rate
router.delete('/:id', auth, async (req, res) => {
  if (req.user.role !== 'hr' && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Not authorized' });
  }

  try {
    await db.query('DELETE FROM allowance_rates WHERE id = ?', [req.params.id]);
    res.json({ message: 'Deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
