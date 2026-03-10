export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, amount, name } = req.body;

  if (!phone || !amount || amount < 200) {
    return res.status(400).json({ error: 'Invalid phone or amount' });
  }

  try {
    const response = await fetch('https://payment.intasend.com/api/v1/send-money/mpesa-b2c/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.INTASEND_SECRET}`,
        'X-IntaSend-Public-Key': process.env.INTASEND_PUBLIC,
      },
      body: JSON.stringify({
        currency: 'KES',
        transactions: [{
          name:    name,
          account: phone,
          amount:  amount,
        }],
        requires_approval: 'NO',
      }),
    });

    const data = await response.json();
    return res.status(response.ok ? 200 : 400).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
