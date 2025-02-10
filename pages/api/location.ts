// pages/api/location.ts
import type { NextApiRequest, NextApiResponse } from 'next';

let classLocation: any = null;

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'POST') {
    // Öğretmen konumu kaydediyor
    classLocation = req.body;
    return res.status(200).json({ success: true });
  } else if (req.method === 'GET') {
    // Öğrenci konumu alıyor
    if (!classLocation) {
      return res.status(404).json({ error: 'Konum bulunamadı' });
    }
    return res.status(200).json(classLocation);
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}