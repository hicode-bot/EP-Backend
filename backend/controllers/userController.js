const EmailService = require('../services/emailService');

// In your registration controller
async function register(req, res) {
    try {
        // ... existing user registration code ...
        
        // Send welcome email
        await EmailService.sendWelcomeEmail(user.email, user.name);
        
        res.status(201).json({ message: 'User registered successfully' });
    } catch (error) {
        // ... error handling ...
    }
}

// In your expense controller
async function addExpense(req, res) {
    try {
        // ... existing expense creation code ...
        
        // Send expense notification
        await EmailService.sendExpenseAlert(user.email, user.name, expense.amount, expense.category);
        
        res.status(201).json({ message: 'Expense added successfully' });
    } catch (error) {
        // ... error handling ...
    }
}
