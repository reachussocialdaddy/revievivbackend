const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { Client, Environment } = require('square');
const { Resend } = require('resend');
const crypto = require('crypto');

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Supabase Client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// Square Client
const squareClient = new Client({
    environment: process.env.NODE_ENV === 'production' ? Environment.Production : Environment.Sandbox,
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
});

// Resend Client
const resend = new Resend(process.env.RESEND_API_KEY);

// --- Routes ---

// 1. Health Check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 2. Bookings
app.get('/api/bookings', async (req, res) => {
    const { data, error } = await supabase
        .from('bookings')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 3. Enquiries
app.get('/api/enquiries', async (req, res) => {
    const { data, error } = await supabase
        .from('enquiries')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post('/api/enquiries', async (req, res) => {
    const { name, email, subject, message } = req.body;
    
    const { data, error } = await supabase
        .from('enquiries')
        .insert([{ name, email, subject, message, status: 'Pending' }]);

    if (error) return res.status(500).json({ error: error.message });

    // Send email notification for enquiry
    try {
        await resend.emails.send({
            from: 'Revive IV <onboarding@resend.dev>',
            to: ['info@reviveiv.io'],
            subject: `New Enquiry: ${subject}`,
            html: `<p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>Message:</strong> ${message}</p>`
        });
    } catch (e) {
        console.error('Email sending failed:', e);
    }

    res.status(201).json({ success: true, data });
});

// 4. Products
app.get('/api/products', async (req, res) => {
    const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('name');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.put('/api/products/:id', async (req, res) => {
    const { id } = req.params;
    const { name, price, category, status } = req.body;

    const { data, error } = await supabase
        .from('products')
        .update({ name, price, category, status })
        .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, data });
});

app.post('/api/products', async (req, res) => {
    const { name, price, category, status } = req.body;

    const { data, error } = await supabase
        .from('products')
        .insert([{ name, price, category, status: status || 'Active' }]);

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ success: true, data });
});

// 5. Payments & Bookings Integration
app.post('/api/process-payment', async (req, res) => {
    const { sourceId, currency, customerInfo } = req.body;

    if (!sourceId || !customerInfo || !customerInfo.cart) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    try {
        const subtotal = customerInfo.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const bookingType = customerInfo.bookingType || 'individual';
        let finalTotal = subtotal;
        
        if (bookingType === 'group') {
            finalTotal = subtotal * 0.90; // 10% discount
        }
        
        const amount = finalTotal * 0.20; // 20% advance
        const idempotencyKey = crypto.randomUUID();

        // Create Square Payment
        const paymentResponse = await squareClient.paymentsApi.createPayment({
            sourceId,
            idempotencyKey,
            amountMoney: {
                amount: BigInt(Math.round(amount * 100)),
                currency: currency || 'USD',
            },
        });

        const payment = paymentResponse.result.payment;

        // Create Booking in Supabase
        const { data: bookingData, error: bookingError } = await supabase
            .from('bookings')
            .insert([{
                customer_name: `${customerInfo.fname} ${customerInfo.lname}`,
                email: customerInfo.email,
                phone: customerInfo.phone,
                date: customerInfo.date,
                timeslot: customerInfo.timeslot,
                location: `${customerInfo.street}, ${customerInfo.city} ${customerInfo.zip}`,
                instructions: customerInfo.instructions || '',
                amount_paid: amount,
                cart_items: customerInfo.cart || [],
                payment_id: payment.id,
                status: 'Pending'
            }]);

        if (bookingError) {
            console.error('Booking creation error:', bookingError);
            // Even if booking fails, payment succeeded. We should log this carefully.
        }

        // Send Confirmation Emails
        const cartItemsHtml = customerInfo.cart && customerInfo.cart.length > 0 
            ? customerInfo.cart.map(item => `<li>${item.name} - $${item.price.toFixed(2)}</li>`).join('') 
            : '<li>No items (Custom Booking)</li>';

        const adminEmailHtml = `
            <h2>New Booking & Deposit Received</h2>
            <p><strong>Name:</strong> ${customerInfo.fname} ${customerInfo.lname}</p>
            <p><strong>Email:</strong> ${customerInfo.email}</p>
            <p><strong>Phone:</strong> ${customerInfo.phone}</p>
            <p><strong>Date & Time:</strong> ${customerInfo.date} at ${customerInfo.timeslot}</p>
            <p><strong>Location:</strong> ${customerInfo.street}, ${customerInfo.city} ${customerInfo.zip}</p>
            <p><strong>Deposit Paid:</strong> $${amount.toFixed(2)}</p>
            <h3>Cart Items:</h3>
            <ul>${cartItemsHtml}</ul>
        `;

        try {
            // To Admin
            await resend.emails.send({
                from: 'Revive IV <onboarding@resend.dev>',
                to: ['info@reviveiv.io'],
                subject: 'New Booking & Payment Received',
                html: adminEmailHtml
            });

            // To Customer
            await resend.emails.send({
                from: 'Revive IV <onboarding@resend.dev>',
                to: [customerInfo.email],
                subject: 'Your Booking Confirmation - Revive IV',
                html: `<h2>Your Booking is Confirmed!</h2>
                <p>Hi ${customerInfo.fname},</p>
                <p>Thank you for booking with Revive IV Hydration. We have successfully received your 20% advance deposit of $${amount.toFixed(2)}.</p>
                <p>Our concierge will contact you shortly to confirm the final details for your appointment on <strong>${customerInfo.date} at ${customerInfo.timeslot}</strong>.</p>`
            });
        } catch (emailError) {
            console.error('Email sending failed:', emailError);
        }

        res.status(200).json({ success: true, paymentId: payment.id });

    } catch (error) {
        console.error('Square Payment Error:', error);
        let errorMessage = 'Payment processing failed';
        if (error.errors && error.errors.length > 0) {
            errorMessage = error.errors[0].detail;
        }
        res.status(500).json({ success: false, error: errorMessage });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
