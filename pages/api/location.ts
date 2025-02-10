// Örnek: Dosya sistemi ile kalıcı depolama
import fs from 'fs/promises';
import path from 'path';

const LOCATION_FILE = path.join(process.cwd(), 'data/location.json');

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'POST') {
    try {
      await fs.writeFile(LOCATION_FILE, JSON.stringify(req.body));
      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: 'Konum kaydedilemedi' });
    }
  } else if (req.method === 'GET') {
    try {
      const data = await fs.readFile(LOCATION_FILE, 'utf8');
      return res.status(200).json(JSON.parse(data));
    } catch (error) {
      return res.status(404).json({ error: 'Konum bulunamadı' });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}