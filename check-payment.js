export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { invoice_id } = req.query;
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id required' });

  try {
    const response = await fetch(`https://payment.intasend.com/api/v1/payment/invoices/${invoice_id}/`, {
      headers: {
        'Authorization': `Bearer ${process.env.INTASEND_SECRET}`,
        'X-IntaSend-Public-Key': process.env.INTASEND_PUBLIC,
      },
    });
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
