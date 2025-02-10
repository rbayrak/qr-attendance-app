// pages/api/location.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { readFileSync, writeFileSync } from 'fs';

const LOCATION_FILE = './data/location.json';

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'POST') {
    try {
      // Öğretmen konumu kaydediyor
      writeFileSync(LOCATION_FILE, JSON.stringify(req.body));
      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: 'Konum kaydedilemedi' });
    }
  } 
  
  if (req.method === 'GET') {
    try {
      // Öğrenci konumu alıyor
      const location = JSON.parse(readFileSync(LOCATION_FILE, 'utf-8'));
      return res.status(200).json(location);
    } catch {
      return res.status(404).json({ error: 'Konum bulunamadı' });
    }
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}
