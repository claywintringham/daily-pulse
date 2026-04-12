// api/translate.js
// POST /api/translate
// Body:    { items: [{ id, headline, summary }, ...] }
// Returns: { items: [{ id, headline, summary }, ...] }  ← Traditional Chinese
//
// Called client-side when the user toggles the digest to 中文.
// Results are cached in the browser for the session — this endpoint is only
// called once per digest load.

import { translateToZh } from '../lib/llm.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '`items` array is required' });
  }
  if (items.length > 60) {
    return res.status(400).json({ error: 'Too many items (max 60)' });
  }

  try {
    const translated = await translateToZh(items);
    return res.status(200).json({ items: translated });
  } catch (err) {
    console.error('[translate] error:', err.message);
    return res.status(500).json({ error: 'Translation failed' });
  }
}
