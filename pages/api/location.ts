// pages/api/location.ts
// Öğretmen panelindeki konum seçimi için tanımlı yoklama konumlarının listesi
// (yalnızca kod ve ad; koordinatlar gönderilmez)
import type { NextApiRequest, NextApiResponse } from 'next';
import { getPlaces } from '@/utils/places';

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      places: getPlaces().map(({ code, name }) => ({ code, name })),
      serverTime: Date.now()
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
