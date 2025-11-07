const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR'
    }).format(amount);
};

const getStatusBadge = (status, inactive_reason) => {
    // Show full status including inactive reason
    if (status === 'inactive' && inactive_reason) {
        return `<span style="display:inline-block;padding:6px 18px;border-radius:16px;font-weight:600;font-size:1rem;color:#d32f2f;background:#ffebee;border:1px solid #d32f2f;margin-bottom:8px;">${inactive_reason.toUpperCase()}</span>`;
    }
    const statusMap = {
        pending: { label: 'Pending Activation', color: '#ef6c00', bg: '#fff3e0' },
        coordinator_approved: { label: 'Coordinator Approved', color: '#1976d2', bg: '#e3f2fd' },
        coordinator_rejected: { label: 'Coordinator Rejected', color: '#d32f2f', bg: '#ffebee' },
        hr_approved: { label: 'HR Approved', color: '#388e3c', bg: '#e8f5e9' },
        hr_rejected: { label: 'HR Rejected', color: '#d32f2f', bg: '#ffebee' },
        accounts_approved: { label: 'Accounts Approved', color: '#388e3c', bg: '#e8f5e9' },
        accounts_rejected: { label: 'Accounts Rejected', color: '#d32f2f', bg: '#ffebee' },
        reassigned: { label: 'Reassigned', color: '#0288d1', bg: '#e1f5fe' },
        deceased: { label: 'Deceased', color: '#6d4c41', bg: '#efebe9' }
    };
    const s = statusMap[status] || statusMap.pending;
    return `<span style="display:inline-block;padding:6px 18px;border-radius:16px;font-weight:600;font-size:1rem;color:${s.color};background:${s.bg};border:1px solid ${s.color};margin-bottom:8px;">${s.label}</span>`;
};

const getExpenseStatusEmailTemplate = (data) => {
    // Compose full name with middle name if present
    const employeeFullName = (data.first_name || data.middle_name || data.last_name)
        ? `${data.first_name || ''}${data.middle_name ? ' ' + data.middle_name : ''}${data.last_name ? ' ' + data.last_name : ''}`.replace(/\s+/g, ' ').trim()
        : (data.employeeName || 'N/A');

    const safeData = {
        recipientName: data.recipientName || 'User',
        expenseId: data.expenseId || 'N/A',
        status: data.status || 'pending',
        previousStatus: data.previousStatus || 'N/A',
        reviewerName: data.reviewerName || 'System',
        employeeName: employeeFullName,
        employeeCode: data.employeeCode || data.emp_code || data.expenseDetails?.emp_code || '',
        department: data.department || data.department_name || data.expenseDetails?.department_name || '',
        designation: data.designation || data.designation_name || data.expenseDetails?.designation_name || '',
        projectCode: data.projectCode || data.project_code || 'N/A',
        projectName: data.projectName || data.project_name || 'N/A',
        siteLocation: data.siteLocation || data.site_location || 'N/A',
        daAllowanceTotal: Number(data.daAllowanceTotal || 0),
        travelFareTotal: Number(data.travelFareTotal || 0),
        foodExpenseTotal: Number(data.foodExpenseTotal || 0),
        hotelExpenseTotal: Number(data.hotelExpenseTotal || 0),
        claimAmount: Number(data.claimAmount || 0),
        requiresAction: data.requiresAction || false,
        comment: data.comment || ''
    };

    // Add inactive_reason to badge if present
    const inactive_reason = data.inactive_reason || '';

    return `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 700px; margin: 0 auto; background: #f8f9fa; border-radius: 12px; border: 1px solid #e0e0e0; box-shadow: 0 2px 12px rgba(25,118,210,0.08); padding: 32px;">
            <div style="text-align:center; margin-bottom:24px;">
                <img src="https://cdn-icons-png.flaticon.com/512/2920/2920257.png" alt="Expense" style="width:56px; margin-bottom:8px;" />
                <h2 style="color:#1976d2; margin:0;">Expense Status Update</h2>
                ${getStatusBadge(safeData.status, inactive_reason)}
            </div>
            <div style="background:#fff; border-radius:8px; padding:24px; margin-bottom:24px;">
                <p style="font-size:1.1rem; color:#333; margin-bottom:8px;">Hello <b>${safeData.recipientName}</b>,</p>
                <p style="font-size:1rem; color:#444; margin-bottom:16px;">
                    The expense claim  for <b>${safeData.employeeName}</b> has been updated.
                </p>
                ${safeData.requiresAction ? `
                    <div style="background:#fff3cd; color:#856404; padding:12px; border-radius:6px; margin-bottom:16px; font-weight:600;">
                        ⚠️ <span>Action Required: Please review this expense.</span>
                    </div>
                ` : ''}
                <table style="width:100%; border-collapse:collapse; margin-top:12px;">
                    <tr>
                        <td style="padding:8px; font-weight:600; color:#1976d2;">Employee Name</td>
                        <td style="padding:8px;">${safeData.employeeName}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">Employee Code</td>
                        <td style="padding:8px;">${safeData.employeeCode}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600;">Department</td>
                        <td style="padding:8px;">${safeData.department}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">Designation</td>
                        <td style="padding:8px;">${safeData.designation}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600; color:#1976d2;">Project Code</td>
                        <td style="padding:8px;">${safeData.projectCode}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">Project Name</td>
                        <td style="padding:8px;">${safeData.projectName}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600;">Site Location</td>
                        <td style="padding:8px;">${safeData.siteLocation}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">DA (Daily Allowance) Total</td>
                        <td style="padding:8px;">${formatCurrency(safeData.daAllowanceTotal)}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600;">Total Travel Fare</td>
                        <td style="padding:8px;">${formatCurrency(safeData.travelFareTotal)}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">Total Food Expense</td>
                        <td style="padding:8px;">${formatCurrency(safeData.foodExpenseTotal)}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600;">Total Hotel Expense</td>
                        <td style="padding:8px;">${formatCurrency(safeData.hotelExpenseTotal)}</td>
                    </tr>
                    <tr style="background:#e8f5e9;">
                        <td style="padding:8px; font-weight:600; color:#388e3c;">Claim Amount</td>
                        <td style="padding:8px; color:#388e3c; font-weight:700;">${formatCurrency(safeData.claimAmount)}</td>
                    </tr>
                </table>
            </div>
            <div style="background:#fff; border-radius:8px; padding:24px; margin-bottom:24px;">
                <h3 style="color:#1976d2; margin-top:0;">Review Information</h3>
                <table style="width:100%; border-collapse:collapse;">
                    <tr>
                        <td style="padding:8px; font-weight:600;">Previous Status</td>
                        <td style="padding:8px;">${safeData.previousStatus}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600;">New Status</td>
                        <td style="padding:8px;">${safeData.status}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600;">Reviewed By</td>
                        <td style="padding:8px;">${safeData.reviewerName}</td>
                    </tr>
                </table>
                ${safeData.comment ? `
                    <div style="background:#f8f9fa; padding:12px; border-radius:6px; margin-top:12px;">
                        <strong>Comment:</strong><br>
                        ${safeData.comment}
                    </div>
                ` : ''}
            </div>
            <div style="text-align:center; margin-top:24px; padding:16px; background:#e3f2fd; border-radius:8px;">
                <p style="margin:0; font-size:1rem;">Please login to the system for more details and actions.</p>
                <p style="color:#6c757d; margin-top:8px; font-size:0.95rem;">
                    This is an automated email. Please do not reply.
                </p>
            </div>
        </div>
    `;
};

const getExpenseSubmissionTemplate = (data) => {
    // Compose full name with middle name if present
    let employeeFullName = '';
    if (data.employeeFirstName || data.employeeMiddleName || data.employeeLastName) {
        employeeFullName = `${data.employeeFirstName || ''}${data.employeeMiddleName ? ' ' + data.employeeMiddleName : ''}${data.employeeLastName ? ' ' + data.employeeLastName : ''}`.replace(/\s+/g, ' ').trim();
    }
    if (!employeeFullName) {
        employeeFullName = data.employeeName && data.employeeName !== 'N/A' ? data.employeeName : 'N/A';
    }

    const safeData = {
        recipientName: data.recipientName || 'User',
        employeeCode: data.employeeCode || data.emp_code || data.expenseDetails?.emp_code || '',
        designation: data.designation || data.designation_name || data.expenseDetails?.designation_name || '',
        employeeName: employeeFullName,
        employeeFirstName: data.employeeFirstName || '',
        employeeMiddleName: data.employeeMiddleName || '',
        employeeLastName: data.employeeLastName || '',
        department: data.department || data.department_name || data.expenseDetails?.department_name || '',
        projectCode: data.projectCode || data.expenseDetails?.project_code || 'N/A',
        projectName: data.projectName || data.expenseDetails?.project_name || 'N/A',
        siteLocation: data.siteLocation || data.expenseDetails?.site_location || 'N/A',
        daAllowanceTotal: Number(data.daAllowanceTotal || data.expenseDetails?.da_allowance_total || 0),
        travelFareTotal: Number(data.travelFareTotal || data.expenseDetails?.travel_fare_total || 0),
        foodExpenseTotal: Number(data.foodExpenseTotal || data.expenseDetails?.food_expense_total || 0),
        hotelExpenseTotal: Number(data.hotelExpenseTotal || data.expenseDetails?.hotel_expense_total || 0),
        claimAmount: Number(data.claimAmount || data.expenseDetails?.claim_amount || 0)
    };

    return `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 700px; margin: 0 auto; background: #f8f9fa; border-radius: 12px; border: 1px solid #e0e0e0; box-shadow: 0 2px 12px rgba(25,118,210,0.08); padding: 32px;">
            <div style="text-align:center; margin-bottom:24px;">
                <img src="https://cdn-icons-png.flaticon.com/512/2920/2920257.png" alt="Expense" style="width:56px; margin-bottom:8px;" />
                <h2 style="color:#1976d2; margin:0;">Expense Submission Notification</h2>
                <span style="display:inline-block;padding:6px 18px;border-radius:16px;font-weight:600;font-size:1rem;color:#dc3545;background:#fff3cd;border:1px solid #dc3545;margin-bottom:8px;">Action Required</span>
            </div>
            <div style="background:#fff; border-radius:8px; padding:24px; margin-bottom:24px;">
                <p style="font-size:1.1rem; color:#333; margin-bottom:8px;">Dear <b>${safeData.recipientName}</b>,</p>
                <p style="font-size:1rem; color:#444; margin-bottom:16px;">
                    A new expense claim has been submitted by  and requires your review.
                </p>
                <table style="width:100%; border-collapse:collapse; margin-top:12px;">
                    <tr>
                        <td style="padding:8px; font-weight:600; color:#1976d2;">Employee Code</td>
                        <td style="padding:8px;">${safeData.employeeCode}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600; color:#1976d2;">Department</td>
                        <td style="padding:8px;">${safeData.department}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600; color:#1976d2;">Designation</td>
                        <td style="padding:8px;">${safeData.designation}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">Project Code</td>
                        <td style="padding:8px;">${safeData.projectCode}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600;">Project Name</td>
                        <td style="padding:8px;">${safeData.projectName}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">Site Location</td>
                        <td style="padding:8px;">${safeData.siteLocation}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600;">DA (Daily Allowance) Total</td>
                        <td style="padding:8px;">${formatCurrency(safeData.daAllowanceTotal)}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">Total Travel Fare</td>
                        <td style="padding:8px;">${formatCurrency(safeData.travelFareTotal)}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600;">Total Food Expense</td>
                        <td style="padding:8px;">${formatCurrency(safeData.foodExpenseTotal)}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">Total Hotel Expense</td>
                        <td style="padding:8px;">${formatCurrency(safeData.hotelExpenseTotal)}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600; color:#388e3c;">Claim Amount</td>
                        <td style="padding:8px; color:#388e3c; font-weight:700;">${formatCurrency(safeData.claimAmount)}</td>
                    </tr>
                </table>
            </div>
            <div style="text-align:center; margin-top:24px; padding:16px; background:#e3f2fd; border-radius:8px;">
                <p style="margin:0; font-size:1rem;">Please log in to the expense management system to review and take necessary action on this claim.</p>
                <p style="color:#6c757d; margin-top:8px; font-size:0.95rem;">This is an automated notification. Please do not reply to this email.</p>
            </div>
        </div>
    `;
};

const getExpenseResubmissionTemplate = (data) => {
    let employeeFullName = '';
    if (data.employeeFirstName || data.employeeMiddleName || data.employeeLastName) {
        employeeFullName = `${data.employeeFirstName || ''}${data.employeeMiddleName ? ' ' + data.employeeMiddleName : ''}${data.employeeLastName ? ' ' + data.employeeLastName : ''}`.replace(/\s+/g, ' ').trim();
    }
    if (!employeeFullName) {
        employeeFullName = data.employeeName ? data.employeeName : '';
    }
    const safeData = {
        recipientName: data.recipientName || '',
        employeeCode: data.employeeCode || data.emp_code || data.expenseDetails?.emp_code || '',
        department: data.department || data.department_name || data.expenseDetails?.department_name || '',
        designation: data.designation || data.designation_name || data.expenseDetails?.designation_name || '',
        employeeName: employeeFullName,
        projectCode: data.projectCode || data.expenseDetails?.project_code || '',
        projectName: data.projectName || data.expenseDetails?.project_name || '',
        siteLocation: data.siteLocation || data.expenseDetails?.site_location || '',
        daAllowanceTotal: Number(data.daAllowanceTotal || data.expenseDetails?.da_allowance_total || 0),
        travelFareTotal: Number(data.travelFareTotal || data.expenseDetails?.travel_fare_total || 0),
        foodExpenseTotal: Number(data.foodExpenseTotal || data.expenseDetails?.food_expense_total || 0),
        hotelExpenseTotal: Number(data.hotelExpenseTotal || data.expenseDetails?.hotel_expense_total || 0),
        claimAmount: Number(data.claimAmount || data.expenseDetails?.claim_amount || 0)
    };
    return `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 700px; margin: 0 auto; background: #f8f9fa; border-radius: 12px; border: 1px solid #e0e0e0; box-shadow: 0 2px 12px rgba(25,118,210,0.08); padding: 32px;">
            <div style="text-align:center; margin-bottom:24px;">
                <img src="https://cdn-icons-png.flaticon.com/512/2920/2920257.png" alt="Expense" style="width:56px; margin-bottom:8px;" />
                <h2 style="color:#1976d2; margin:0;">Expense Resubmission</h2>
                <span style="display:inline-block;padding:6px 18px;border-radius:16px;font-weight:600;font-size:1rem;color:#dc3545;background:#fff3cd;border:1px solid #dc3545;margin-bottom:8px;">Resubmission</span>
            </div>
            <div style="background:#fff; border-radius:8px; padding:24px; margin-bottom:24px;">
                <p style="font-size:1.1rem; color:#333; margin-bottom:8px;">Dear <b>${safeData.recipientName}</b>,</p>
                <p style="font-size:1rem; color:#444; margin-bottom:16px;">
                    An expense claim has been resubmitted and requires your review.
                </p>
                <table style="width:100%; border-collapse:collapse; margin-top:12px;">
                    <tr>
                        <td style="padding:8px; font-weight:600; color:#1976d2;">Employee Code</td>
                        <td style="padding:8px;">${safeData.employeeCode}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600; color:#1976d2;">Department</td>
                        <td style="padding:8px;">${safeData.department}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600; color:#1976d2;">Designation</td>
                        <td style="padding:8px;">${safeData.designation}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">Project Code</td>
                        <td style="padding:8px;">${safeData.projectCode}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600;">Project Name</td>
                        <td style="padding:8px;">${safeData.projectName}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">Site Location</td>
                        <td style="padding:8px;">${safeData.siteLocation}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600;">DA (Daily Allowance) Total</td>
                        <td style="padding:8px;">${formatCurrency(safeData.daAllowanceTotal)}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">Total Travel Fare</td>
                        <td style="padding:8px;">${formatCurrency(safeData.travelFareTotal)}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600;">Total Food Expense</td>
                        <td style="padding:8px;">${formatCurrency(safeData.foodExpenseTotal)}</td>
                    </tr>
                    <tr style="background:#f8f9fa;">
                        <td style="padding:8px; font-weight:600;">Total Hotel Expense</td>
                        <td style="padding:8px;">${formatCurrency(safeData.hotelExpenseTotal)}</td>
                    </tr>
                    <tr>
                        <td style="padding:8px; font-weight:600; color:#388e3c;">Claim Amount</td>
                        <td style="padding:8px; color:#388e3c; font-weight:700;">${formatCurrency(safeData.claimAmount)}</td>
                    </tr>
                </table>
            </div>
            <div style="text-align:center; margin-top:24px; padding:16px; background:#e3f2fd; border-radius:8px;">
                <p style="margin:0; font-size:1rem;">Please log in to the expense management system to review and take necessary action on this resubmitted claim.</p>
                <p style="color:#6c757d; margin-top:8px; font-size:0.95rem;">This is an automated notification. Please do not reply to this email.</p>
            </div>
        </div>
    `;
};

module.exports = {
    getExpenseStatusEmailTemplate,
    getExpenseSubmissionTemplate,
    getExpenseResubmissionTemplate
};
