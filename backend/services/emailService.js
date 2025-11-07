const transporter = require('../config/emailConfig');
const { getExpenseStatusEmailTemplate, getExpenseSubmissionTemplate, getExpenseResubmissionTemplate } = require('../utils/emailTemplates');

class EmailService {
    static async sendEmail(to, subject, html, fromEmail = null, fromName = null) {
        try {
            if (!to) {
                throw new Error('Recipient email is required');
            }

            const mailOptions = {
                from: fromEmail ? `"${fromName || fromEmail}" <${fromEmail}>` : `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
                to,
                subject,
                html
            };

            const info = await transporter.sendMail(mailOptions);
            console.log('Email sent successfully:', info.messageId);
            return info;
        } catch (error) {
            console.error('Error sending email:', error);
            throw error;
        }
    }

    static async sendWelcomeEmail(userEmail, userName) {
        const subject = 'Welcome to Expense Management System';
        const html = `
            <h1>Welcome ${userName}!</h1>
            <p>Thank you for registering with our Expense Management System.</p>
            <p>You can now start tracking your expenses efficiently!</p>
        `;
        return this.sendEmail(userEmail, subject, html);
    }

    static async sendExpenseAlert(userEmail, userName, amount, category) {
        const subject = 'New Expense Added';
        const html = `
            <h1>New Expense Notification</h1>
            <p>Hello ${userName},</p>
            <p>A new expense of ${amount} has been added to your account under category ${category}.</p>
        `;
        return this.sendEmail(userEmail, subject, html);
    }

    static async notifyExpenseSubmission(expenseData) {
        try {
            const coordinators = expenseData.coordinators || [];
            for (const coordinator of coordinators) {
                await this.sendEmail(
                    coordinator.email,
                    'New Expense Submission Requires Review',
                    getExpenseSubmissionTemplate({
                        recipientName: coordinator.name || expenseData.recipientName || 'User',
                        employeeFirstName: expenseData.employeeFirstName || expenseData.first_name || '',
                        employeeMiddleName: expenseData.employeeMiddleName || expenseData.middle_name || '',
                        employeeLastName: expenseData.employeeLastName || expenseData.last_name || '',
                        employeeName: (expenseData.employeeFirstName || expenseData.first_name || '') + (expenseData.employeeMiddleName || expenseData.middle_name ? ' ' + (expenseData.employeeMiddleName || expenseData.middle_name) : '') + (expenseData.employeeLastName || expenseData.last_name ? ' ' + (expenseData.employeeLastName || expenseData.last_name) : ''),
                        employeeCode: expenseData.employeeCode || expenseData.emp_code || '',
                        designation: expenseData.designation || expenseData.designation_name || '',
                        department: expenseData.department || expenseData.department_name || '',
                        projectCode: expenseData.projectCode || expenseData.project_code || '',
                        projectName: expenseData.projectName || expenseData.project_name || '',
                        siteLocation: expenseData.siteLocation || expenseData.site_location || '',
                        daAllowanceTotal: Number(expenseData.daAllowanceTotal || 0),
                        travelFareTotal: Number(expenseData.travelFareTotal || 0),
                        foodExpenseTotal: Number(expenseData.foodExpenseTotal || 0),
                        hotelExpenseTotal: Number(expenseData.hotelExpenseTotal || 0),
                        claimAmount: Number(expenseData.claimAmount || 0)
                    })
                );
            }
        } catch (error) {
            console.error('Error sending submission notifications:', error);
            throw error;
        }
    }

    static async notifyExpenseStatusUpdate(notificationData) {
        try {
            const { recipientEmail, reviewerEmail, reviewerName, ...data } = notificationData;
            if (!recipientEmail) {
                throw new Error('Recipient email is required for status update notification');
            }
            // Remove expenseId, N/A, 0 from template data
            const cleanData = { ...data };
            if (cleanData.expenseId) delete cleanData.expenseId;
            Object.keys(cleanData).forEach(key => {
                if (cleanData[key] === 'N/A' || cleanData[key] === 0) cleanData[key] = '';
            });
            return await this.sendEmail(
                recipientEmail,
                `Expense Status Update`,
                getExpenseStatusEmailTemplate({
                    recipientName: cleanData.recipientName || 'User',
                    status: cleanData.status || '',
                    previousStatus: cleanData.previousStatus || '',
                    reviewerName: reviewerName || '',
                    employeeFirstName: cleanData.employeeFirstName || cleanData.first_name || '',
                    employeeMiddleName: cleanData.employeeMiddleName || cleanData.middle_name || '',
                    employeeLastName: cleanData.employeeLastName || cleanData.last_name || '',
                    employeeName: (cleanData.employeeFirstName || cleanData.first_name || '') + (cleanData.employeeMiddleName || cleanData.middle_name ? ' ' + (cleanData.employeeMiddleName || cleanData.middle_name) : '') + (cleanData.employeeLastName || cleanData.last_name ? ' ' + (cleanData.employeeLastName || cleanData.last_name) : ''),
                    employeeCode: cleanData.employeeCode || cleanData.emp_code || '',
                    department: cleanData.department || cleanData.department_name || '',
                    designation: cleanData.designation || cleanData.designation_name || '',
                    projectCode: cleanData.projectCode || cleanData.project_code || '',
                    projectName: cleanData.projectName || cleanData.project_name || '',
                    siteLocation: cleanData.siteLocation || cleanData.site_location || '',
                    daAllowanceTotal: cleanData.daAllowanceTotal || '',
                    travelFareTotal: cleanData.travelFareTotal || '',
                    foodExpenseTotal: cleanData.foodExpenseTotal || '',
                    hotelExpenseTotal: cleanData.hotelExpenseTotal || '',
                    claimAmount: cleanData.claimAmount || '',
                    requiresAction: cleanData.requiresAction || false,
                    comment: cleanData.comment || ''
                }),
                reviewerEmail || null,
                reviewerName || null
            );
        } catch (error) {
            console.error('Error sending status notification:', error);
            throw error;
        }
    }

    static async notifyNextReviewers(connection, currentStatus, expenseData) {
        try {
            let query = '';
            let role = '';
            let subject = 'Expense Status Update';
            let htmlTemplate = getExpenseStatusEmailTemplate;
            // Use resubmission template and title if status is resubmission or after rejection
            if (expenseData.isResubmission) {
                subject = 'Expense Resubmission';
                htmlTemplate = getExpenseResubmissionTemplate;
            }
            if (currentStatus === 'coordinator_approved') {
                role = 'hr';
                query = `
                    SELECT e.email, CONCAT(e.first_name, ' ', e.last_name) as name 
                    FROM employees e 
                    JOIN users u ON e.emp_id = u.emp_id 
                    WHERE u.role = ?
                `;
            } else if (currentStatus === 'hr_approved') {
                role = 'accounts';
                query = `
                    SELECT e.email, CONCAT(e.first_name, ' ', e.last_name) as name 
                    FROM employees e 
                    JOIN users u ON e.emp_id = u.emp_id 
                    WHERE u.role = ?
                `;
            }
            if (query) {
                const [reviewers] = await connection.query(query, [role]);
                for (const reviewer of reviewers) {
                    await this.sendEmail(
                        reviewer.email,
                        subject,
                        htmlTemplate({
                            ...expenseData,
                            recipientName: reviewer.name,
                            recipientRole: role.toUpperCase(),
                            requiresAction: true
                        })
                    );
                }
            }
        } catch (error) {
            console.error(`Error notifying ${currentStatus} reviewers:`, error);
            throw error;
        }
    }

    static async sendWorkflowNotifications(connection, expenseData, currentStatus) {
        try {
            // Always notify the expense submitter
            if (expenseData.employeeEmail) {
                await this.sendEmail(
                    expenseData.employeeEmail,
                    `Expense Status Update - ID: ${expenseData.expenseId}`,
                    getExpenseStatusEmailTemplate({
                        ...expenseData,
                        recipientName: expenseData.employeeName,
                        employeeFirstName: expenseData.employeeFirstName || expenseData.first_name || '',
                        employeeMiddleName: expenseData.employeeMiddleName || expenseData.middle_name || '',
                        employeeLastName: expenseData.employeeLastName || expenseData.last_name || '',
                        employeeName: expenseData.employeeName // fallback
                    })
                );
                console.log('Notification sent to employee:', expenseData.employeeEmail);
            }

            // Notify next level reviewers if approved
            if (currentStatus.includes('approved')) {
                await this.notifyNextReviewers(connection, currentStatus, expenseData);
            }
        } catch (error) {
            console.error('Error in workflow notifications:', error);
            throw error;
        }
    }

    static async sendExpenseResubmissionEmail(to, subject, html) {
        try {
            if (!to) throw new Error('Recipient email is required');
            const mailOptions = {
                from: `${process.env.EMAIL_FROM_NAME || 'Expense Tracker'} <${process.env.EMAIL_USER}>`,
                to,
                subject,
                html
            };
            const info = await transporter.sendMail(mailOptions);
            console.log('Resubmission email sent:', info.messageId);
            return info;
        } catch (error) {
            console.error('Error sending resubmission email:', error);
            throw error;
        }
    }
}

module.exports = EmailService;
