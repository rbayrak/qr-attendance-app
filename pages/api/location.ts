// pages/api/location.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';

const LOCATION_FILE = path.join(process.cwd(), 'location.json');

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'POST') {
    try {
      writeFileSync(LOCATION_FILE, JSON.stringify({
        ...req.body,
        timestamp: Date.now()
      }));
      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: 'Konum kaydedilemedi' });
    }
  } 
  
  if (req.method === 'GET') {
    try {
      if (!existsSync(LOCATION_FILE)) {
        return res.status(404).json({ error: 'Konum bulunamadı' });
      }
      
      const location = JSON.parse(readFileSync(LOCATION_FILE, 'utf8'));
      
      // 24 saatten eski ise konum geçersiz say
      if (Date.now() - location.timestamp > 24 * 60 * 60 * 1000) {
        return res.status(404).json({ error: 'Konum geçersiz' });
      }
      
      return res.status(200).json(location);
    } catch (error) {
      return res.status(500).json({ error: 'Konum okunamadı' });
    }
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}