const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { Client, Environment } = require('square');
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

app.post('/api/bookings', async (req, res) => {
    const { customerInfo } = req.body;
    
    if (!customerInfo) {
        return res.status(400).json({ error: 'Missing customer information' });
    }

    try {
        const subtotal = customerInfo.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const bookingType = customerInfo.bookingType || 'individual';
        let totalAmount = subtotal;
        
        if (bookingType === 'group') {
            totalAmount = subtotal * 0.90; // 10% discount
        }

        const { data, error } = await supabase
            .from('bookings')
            .insert([{
                customer_name: `${customerInfo.fname} ${customerInfo.lname}`,
                email: customerInfo.email,
                phone: customerInfo.phone,
                date: customerInfo.date,
                timeslot: customerInfo.timeslot,
                location: `${customerInfo.street}, ${customerInfo.city} ${customerInfo.zip}`,
                instructions: (customerInfo.instructions || '') + (customerInfo.guestInfo ? `\n\n[GROUP GUEST]\nName: ${customerInfo.guestInfo.name}\nEmail: ${customerInfo.guestInfo.email}\nPhone: ${customerInfo.guestInfo.phone}` : ''),
                total_amount: totalAmount,
                amount_paid: 0,
                cart_items: customerInfo.cart || [],
                status: 'Pending Payment',
                booking_type: bookingType
            }])
            .select();

        if (error) throw error;
        res.status(201).json({ success: true, bookingId: data[0].id });
    } catch (error) {
        console.error('Booking creation error:', error);
        res.status(500).json({ error: error.message });
    }
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
    const { sourceId, currency, bookingId } = req.body;

    if (!sourceId || !bookingId) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    try {
        // 1. Get the booking details
        const { data: booking, error: fetchError } = await supabase
            .from('bookings')
            .select('*')
            .eq('id', bookingId)
            .single();

        if (fetchError || !booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        const totalAmount = parseFloat(booking.total_amount);
        const amountToPay = totalAmount * 0.20; // 20% advance
        const idempotencyKey = crypto.randomUUID();

        // 2. Create Square Payment
        const paymentResponse = await squareClient.paymentsApi.createPayment({
            sourceId,
            idempotencyKey,
            amountMoney: {
                amount: BigInt(Math.round(amountToPay * 100)),
                currency: currency || 'USD',
            },
        });

        const payment = paymentResponse.result.payment;

        // 3. Update Booking in Supabase
        const { error: updateError } = await supabase
            .from('bookings')
            .update({
                amount_paid: amountToPay,
                payment_id: payment.id,
                status: 'Confirmed'
            })
            .eq('id', bookingId);

        if (updateError) {
            console.error('Booking update error:', updateError);
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

// 5. Update Status (Bookings/Enquiries)
app.patch('/api/:type/:id/status', async (req, res) => {
    const { type, id } = req.params;
    const { status, session_status } = req.body;
    const table = type === 'bookings' ? 'bookings' : 'enquiries';

    let updateData = {};
    if (status) updateData.status = status;
    if (session_status) updateData.session_status = session_status;

    try {
        const { data, error } = await supabase
            .from(table)
            .update(updateData)
            .eq('id', id)
            .select();

        if (error) throw error;
        res.status(200).json({ success: true, data });
    } catch (error) {
        console.error(`Error updating ${table} status:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
