-- Run this SQL in your new Supabase project to set up the database

CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    date TEXT,
    timeslot TEXT,
    location TEXT,
    instructions TEXT,
    total_amount DECIMAL,
    amount_paid DECIMAL,
    cart_items JSONB,
    payment_id TEXT,
    status TEXT DEFAULT 'Pending',
    session_status TEXT DEFAULT 'Pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE enquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    subject TEXT,
    message TEXT,
    status TEXT DEFAULT 'Pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    price DECIMAL NOT NULL,
    category TEXT,
    status TEXT DEFAULT 'Active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Initial Data
INSERT INTO products (name, price, category, status) VALUES 
('Liquid Gold', 299, 'IV Drip', 'Active'),
('Immunity Shield', 249, 'IV Drip', 'Active'),
('Vitamin B12 Shot', 49, 'Shot', 'Active');
