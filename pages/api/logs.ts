import type { NextApiRequest, NextApiResponse } from 'next';

let debugLogs: string[] = []; // In-memory log storage

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    // Logları getir
    return res.status(200).json({ logs: debugLogs });
  } 
  else if (req.method === 'POST') {
    // Yeni log ekle
    const { log } = req.body;
    if (!log) {
      return res.status(400).json({ error: 'Log içeriği gerekli' });
    }
    debugLogs.push(log);
    return res.status(200).json({ success: true });
  }
  else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
}