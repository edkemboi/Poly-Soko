export default async function handler(req, res) {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, amount, name, email, api_ref } = req.body;

  if (!phone || !amount || amount < 100) {
    return res.status(400).json({ error: 'Invalid phone or amount' });
  }

  try {
    const response = await fetch('https://payment.intasend.com/api/v1/payment/mpesa-stk-push/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.INTASEND_SECRET}`,
        'X-IntaSend-Public-Key': process.env.INTASEND_PUBLIC,
      },
      body: JSON.stringify({
        first_name:   name.split(' ')[0],
        last_name:    name.split(' ')[1] || '',
        email:        email,
        phone_number: phone,
        amount:       amount,
        currency:     'KES',
        api_ref:      api_ref,
        narrative:    'Poly-Soko Account Top-up',
      }),
    });

    const data = await response.json();
    return res.status(response.ok ? 200 : 400).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
