// pages/api/memory.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { deviceTracker } from '@/utils/deviceTracker';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'DELETE') {
    try {
      deviceTracker.clearMemoryStore();
      return res.status(200).json({ success: true, message: 'Memory store temizlendi' });
    } catch (error) {
      console.error('Memory store temizleme hatası:', error);
      return res.status(500).json({ error: 'İşlem sırasında bir hata oluştu' });
    }
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
}