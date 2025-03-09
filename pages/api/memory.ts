// pages/api/memory.ts

import { NextApiRequest, NextApiResponse } from 'next';
import { deviceTracker } from '@/utils/deviceTracker';
import { google } from 'googleapis'; // Bu satırı ekleyin

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'DELETE') {
    try {
      // 1. memoryStore'u temizle
      deviceTracker.clearMemoryStore();
      
      // 2. Google Sheets'teki StudentDevices sayfasını temizle
      await deviceTracker.clearStudentDevices();
      
      // 3. YENİ: Ana yoklama sayfasındaki cihaz bilgilerini temizle
      const auth = new google.auth.GoogleAuth({
        credentials: {
          type: 'service_account',
          project_id: process.env.GOOGLE_PROJECT_ID,
          private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          client_email: process.env.GOOGLE_CLIENT_EMAIL,
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      const sheets = google.sheets({ version: 'v4', auth });
      
      // Yoklama sayfasındaki tüm verileri getir
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A:Z',
      });
      
      const rows = response.data.values;
      if (rows) {
        // Tüm hücreleri kontrol et
        for (let i = 0; i < rows.length; i++) {
          for (let j = 3; j < rows[i].length; j++) {
            const cell = rows[i][j];
            if (cell && (cell.includes('(DF:') || cell.includes('(HW:'))) {
              // Cihaz bilgisi içeren hücreyi sadece "VAR" olarak değiştir
              await sheets.spreadsheets.values.update({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: `${String.fromCharCode(65 + j)}${i + 1}`,
                valueInputOption: 'RAW',
                requestBody: {
                  values: [['VAR']]
                }
              });
            }
          }
        }
      }
      
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
    res.status(405).json({ error: 'Method Not Allowed' });
  }
}