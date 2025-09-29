// pages/api/students.ts
import { NextApiRequest, NextApiResponse } from 'next';
import { google } from 'googleapis';

// Google Auth
async function getGoogleAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      type: 'service_account',
      project_id: process.env.GOOGLE_PROJECT_ID,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Sadece GET isteklerine izin ver
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // Sadece öğrenci listesini al (A, B, C sütunları)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'A:C',
    });

    const rows = response.data.values || [];
    
    // Başlık satırını atla, sadece öğrenci verilerini dön
    const students = rows.slice(1).map((row: string[]) => ({
      studentId: row[1]?.toString() || '',
      studentName: row[2]?.toString() || ''
    }));

    // Cache header'ı ekle (60 saniye)
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    
    return res.status(200).json({ students });
  } catch (error) {
    console.error('Öğrenci listesi alma hatası:', error);
    return res.status(500).json({ error: 'Öğrenci listesi alınamadı' });
  }
}
