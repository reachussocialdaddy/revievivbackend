const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const square = require('square');
const Client = square.Client;
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
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
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
