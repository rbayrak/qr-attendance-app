import { google } from 'googleapis';
import type { NextApiRequest, NextApiResponse } from 'next';

type ResponseData = {
  success?: boolean;
  error?: string;
  debug?: any;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Debug bilgileri için ana obje
  const debugInfo: any = {
    environmentCheck: {
      SPREADSHEET_ID: process.env.SPREADSHEET_ID,
      GOOGLE_PROJECT_ID: process.env.GOOGLE_PROJECT_ID,
    },
  };

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
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Tablodan verileri al
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID as string,
      range: 'A:F', // Başlıkları ve Hafta-1, Hafta-2... sütunlarını kapsar
    });

    const rows = response.data.values;
    if (!rows) {
      return res.status(404).json({ error: 'Veri bulunamadı' });
    }

    debugInfo.tableHeaders = rows[0]; // Başlıkları debug bilgisine ekle

    // Öğrenciyi bul ve satır numarasını al
    const studentRowIndex = rows.findIndex((row) => row[1] === studentId);
    if (studentRowIndex === -1) {
      debugInfo.error = 'Öğrenci bulunamadı';
      return res.status(404).json({ error: 'Öğrenci bulunamadı', debug: debugInfo });
    }

    const studentRow = studentRowIndex + 1;

    // Hafta sütununu belirle
    const headers = rows[0];
    const weekColumnIndex = headers.findIndex((header) => header.trim() === `Hafta-${week}`);
    if (weekColumnIndex === -1) {
      debugInfo.error = `Hafta-${week} sütunu bulunamadı`;
      return res.status(400).json({ error: `Hafta-${week} sütunu bulunamadı`, debug: debugInfo });
    }

    const weekColumn = String.fromCharCode(65 + weekColumnIndex);
    const range = `${weekColumn}${studentRow}`;

    debugInfo.operationDetails = {
      studentId,
      week,
      weekColumn,
      studentRow,
      range,
    };

    // Yoklamayı güncelle
    const updateResult = await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID as string,
      range,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['VAR']],
      },
    });

    debugInfo.updateResult = updateResult.data;

    res.status(200).json({
      success: true,
      debug: debugInfo,
    });
  } catch (error) {
    debugInfo.error = error instanceof Error ? error.message : 'Bilinmeyen hata';
    console.error('Error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
      debug: debugInfo,
    });
  }
}
