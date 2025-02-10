import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';

const LOCATION_FILE = path.join(process.cwd(), 'data', 'location.json');

// Dizin kontrolü ve oluşturma
if (!fs.existsSync(path.dirname(LOCATION_FILE))) {
  fs.mkdirSync(path.dirname(LOCATION_FILE), { recursive: true });
}

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    if (req.method === 'POST') {
      fs.writeFileSync(LOCATION_FILE, JSON.stringify(req.body));
      return res.status(200).json({ success: true });
    }
    
    if (req.method === 'GET') {
      if (!fs.existsSync(LOCATION_FILE)) {
        return res.status(404).json({ error: 'Konum bulunamadı' });
      }
      const location = JSON.parse(fs.readFileSync(LOCATION_FILE, 'utf-8'));
      return res.status(200).json(location);
    }
  } catch (error) {
    console.error('Location API error:', error);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
}
