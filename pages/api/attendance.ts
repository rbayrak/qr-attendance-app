import { google } from 'googleapis';
import type { NextApiRequest, NextApiResponse } from 'next';

type ResponseData = {
  success?: boolean;
  error?: string;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  console.log('ENV Check:', {
   SPREADSHEET_ID: process.env.SPREADSHEET_ID,
   PROJECT_ID: process.env.GOOGLE_PROJECT_ID,
   CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL
  });  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { studentId, week } = req.body;

    if (!studentId || !week) {
      return res.status(400).json({ error: 'Öğrenci ID ve hafta bilgisi gerekli' });
    }

    // Service Account yetkilendirmesi
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

    // Önce öğrenciyi bul
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'A:C',
    });

    const rows = response.data.values;
    if (!rows) {
      return res.status(404).json({ error: 'Veri bulunamadı' });
    }

    const studentRow = rows.findIndex(row => row[1] === studentId);
    if (studentRow === -1) {
      return res.status(404).json({ error: 'Öğrenci bulunamadı' });
    }

    // Yoklamayı kaydet
    const weekColumn = String.fromCharCode(67 + Number(week) - 1); // C'den başlayarak hafta sütununu bul
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${weekColumn}${studentRow + 1}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['VAR']]
      }
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}