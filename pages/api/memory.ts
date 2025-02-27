// pages/api/memory.ts

import { NextApiRequest, NextApiResponse } from 'next';
import { deviceTracker } from '@/utils/deviceTracker';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Sadece DELETE metodu için işlem yap
  if (req.method === 'DELETE') {
    try {
      // 1. memoryStore'u temizle
      deviceTracker.clearMemoryStore();
      
      // 2. Google Sheets'teki StudentDevices sayfasını temizle
      await deviceTracker.clearStudentDevices();
      
      res.status(200).json({ 
        success: true, 
        message: 'Tüm cihaz kayıtları başarıyla temizlendi' 
      });
    } catch (error) {
      console.error('Memory temizleme hatası:', error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Bilinmeyen hata' 
      });
    }
  } else {
    // Diğer metotlara izin verme
    res.status(405).json({ error: 'Method Not Allowed' });
  }
}