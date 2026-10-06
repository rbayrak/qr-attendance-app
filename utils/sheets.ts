// utils/sheets.ts
//
// Google Sheets erişiminin tek noktası.
//
// Servis hesabının kotası dakikada 60 okuma + 60 yazmadır. 70-80 kişilik bir
// sınıf aynı anda QR okuttuğunda her öğrenci için ayrı okuma/yazma yapmak bu
// kotayı aşar (429) ve istekler zaman aşımına düşer. Bu yüzden:
//  - Tek bir Sheets istemcisi kullanılır (OAuth token her istekte yeniden alınmaz)
//  - Ana sayfa ve "Yoklama Kayıtları" sayfası tek bir batchGet ile okunur,
//    kısa süreli önbellekte tutulur, eşzamanlı okumalar tek çağrıyı paylaşır
//  - Hücre yazmaları ve kayıt satırları kuyrukta biriktirilip tek bir
//    spreadsheets.batchUpdate ile gönderilir (kota açısından tek yazma)

import { google, sheets_v4 } from 'googleapis';

export type SheetRows = string[][];

export const LOG_SHEET_TITLE = 'Yoklama Kayıtları';
export const LOG_HEADERS = [
  'Tarih Saat', 'Hafta', 'Öğrenci No', 'Ad Soyad', 'Sonuç',
  'Cihaz Kimliği', 'Cihaz Modeli', 'IP', 'Not', 'Zaman (ms)'
];
// Kayıt satırı sütun indeksleri
export const LOG_COL = {
  date: 0, week: 1, studentId: 2, name: 3, result: 4,
  deviceId: 5, model: 6, ip: 7, note: 8, timestamp: 9
} as const;

const DEFAULT_MAX_AGE_MS = 5000;
// Ardışık toplu yazmalar arasındaki minimum süre (örnek başına ≤ 40 yazma/dk)
const MIN_FLUSH_INTERVAL_MS = 1500;
// Yazılan veri, Sheets'ten gelen eski bir okuma tarafından gizlenmesin diye
// yazmadan sonra bir süre daha önbelleğe yeniden uygulanır
const RECENT_WRITE_TTL_MS = 15000;

let sheetsClient: sheets_v4.Sheets | null = null;

export function getSheets(): sheets_v4.Sheets {
  if (!sheetsClient) {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        type: 'service_account',
        project_id: process.env.GOOGLE_PROJECT_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return sheetsClient;
}

export function getSpreadsheetId(): string {
  return process.env.SPREADSHEET_ID || '';
}

// 0 tabanlı sütun indeksini harfe çevirir (0 -> A, 25 -> Z)
export function columnLetter(colIndex: number): string {
  return String.fromCharCode(65 + colIndex);
}

function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function getErrorStatus(error: unknown): number | string | undefined {
  const err = error as { response?: { status?: number }; status?: number; code?: number | string } | null;
  return err?.response?.status ?? err?.status ?? err?.code;
}

export function isRetryableError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 ||
    status === '429' || status === 'ECONNRESET' || status === 'ETIMEDOUT' ||
    status === 'EAI_AGAIN' || status === 'ECONNREFUSED';
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Geçici hatalarda (kota aşımı, ağ hatası) üstel bekleme ile yeniden dener
export async function withRetry<T>(operation: () => Promise<T>, maxAttempts = 6): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      const delay = Math.min(1000 * Math.pow(2, attempt), 8000) + Math.floor(Math.random() * 500);
      console.warn(`Sheets geçici hata (${getErrorStatus(error)}), ${delay}ms sonra tekrar (${attempt + 1}/${maxAttempts})`);
      await sleep(delay);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Sayfa bilgileri (ana sayfa = ilk sayfa, kayıt sayfası yoksa oluşturulur)
// ---------------------------------------------------------------------------

interface SheetMeta {
  mainSheetId: number;
  mainTitle: string;
  logSheetId: number;
}

let metaPromise: Promise<SheetMeta> | null = null;

async function loadSheetMeta(): Promise<SheetMeta> {
  const sheets = getSheets();
  const readMeta = async () => {
    const response = await withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: getSpreadsheetId(),
        fields: 'sheets.properties(sheetId,title,index)'
      })
    );
    const list = (response.data.sheets || [])
      .map(sheet => sheet.properties)
      .filter((props): props is sheets_v4.Schema$SheetProperties => !!props);
    const main = list.find(props => props.index === 0) || list[0];
    const log = list.find(props => props.title === LOG_SHEET_TITLE);
    return { main, log };
  };

  let { main, log } = await readMeta();
  if (!main || main.sheetId === undefined || main.sheetId === null) {
    throw new Error('Ana sayfa bulunamadı');
  }

  if (!log) {
    // Kayıt sayfasını ve başlık satırını tek istekte oluştur
    const newSheetId = Math.floor(100000000 + Math.random() * 900000000);
    try {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId: getSpreadsheetId(),
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    sheetId: newSheetId,
                    title: LOG_SHEET_TITLE,
                    gridProperties: { frozenRowCount: 1 }
                  }
                }
              },
              {
                appendCells: {
                  sheetId: newSheetId,
                  rows: [{ values: LOG_HEADERS.map(text => ({ userEnteredValue: { stringValue: text } })) }],
                  fields: 'userEnteredValue'
                }
              }
            ]
          }
        })
      );
      console.log(`"${LOG_SHEET_TITLE}" sayfası oluşturuldu`);
    } catch (error) {
      // Başka bir örnek aynı anda oluşturmuş olabilir; tekrar oku
      console.warn('Kayıt sayfası oluşturulamadı, yeniden kontrol ediliyor:', error);
    }
    ({ main, log } = await readMeta());
    if (!log) throw new Error('Kayıt sayfası oluşturulamadı');
  }

  return {
    mainSheetId: main.sheetId as number,
    mainTitle: main.title || '',
    logSheetId: log.sheetId as number
  };
}

export function getSheetMeta(): Promise<SheetMeta> {
  if (!metaPromise) {
    metaPromise = loadSheetMeta().catch(error => {
      metaPromise = null; // sonraki istekte tekrar dene
      throw error;
    });
  }
  return metaPromise;
}

// ---------------------------------------------------------------------------
// Okuma önbelleği (ana sayfa + kayıt sayfası tek istekte)
// ---------------------------------------------------------------------------

export interface SheetData {
  main: SheetRows;
  log: SheetRows; // başlık satırı dahil
}

let dataCache: { data: SheetData; at: number } | null = null;
let dataInflight: Promise<SheetData> | null = null;

// Kuyrukta bekleyen veya yeni yazılmış veriler
const recentCellWrites = new Map<string, { row: number; col: number; value: string; expiresAt: number }>();
const recentLogRows: { row: string[]; expiresAt: number }[] = [];

function setCell(rows: SheetRows, row: number, col: number, value: string) {
  while (rows.length <= row) rows.push([]);
  const r = rows[row];
  while (r.length < col) r.push('');
  r[col] = value;
}

function logRowSignature(row: unknown[]): string {
  return `${row[LOG_COL.timestamp]}|${row[LOG_COL.studentId]}|${row[LOG_COL.result]}`;
}

function applyRecentWrites(data: SheetData) {
  const now = Date.now();
  for (const [key, write] of recentCellWrites) {
    if (write.expiresAt < now) {
      recentCellWrites.delete(key);
      continue;
    }
    setCell(data.main, write.row, write.col, write.value);
  }
  for (let i = recentLogRows.length - 1; i >= 0; i--) {
    if (recentLogRows[i].expiresAt < now) recentLogRows.splice(i, 1);
  }
  // Okumada zaten bulunan satırları tekrar ekleme
  const existing = new Set(data.log.map(logRowSignature));
  for (const { row } of recentLogRows) {
    if (!existing.has(logRowSignature(row))) data.log.push(row.slice());
  }
}

async function fetchData(): Promise<SheetData> {
  const meta = await getSheetMeta();
  const response = await withRetry(() =>
    getSheets().spreadsheets.values.batchGet({
      spreadsheetId: getSpreadsheetId(),
      ranges: [
        `${quoteSheetTitle(meta.mainTitle)}!A:Z`,
        `${quoteSheetTitle(LOG_SHEET_TITLE)}!A:J`
      ]
    })
  );
  const ranges = response.data.valueRanges || [];
  const data: SheetData = {
    main: (ranges[0]?.values || []) as SheetRows,
    log: ((ranges[1]?.values || []) as unknown[][]).map(row => row.map(cell => String(cell ?? '')))
  };
  applyRecentWrites(data);
  dataCache = { data, at: Date.now() };
  return data;
}

/**
 * Ana sayfa ve kayıt sayfası verisini döndürür. Önbellek `maxAgeMs`'den
 * yeniyse API'ye gidilmez; aynı anda gelen istekler tek bir okumayı paylaşır.
 * `force` true ise mutlaka bu çağrıdan sonra başlatılmış taze bir okuma yapılır.
 */
export async function getSheetData(options: { maxAgeMs?: number; force?: boolean } = {}): Promise<SheetData> {
  const { maxAgeMs = DEFAULT_MAX_AGE_MS, force = false } = options;

  if (!force && dataCache && Date.now() - dataCache.at < maxAgeMs) {
    return dataCache.data;
  }

  if (dataInflight && force) {
    // Devam eden okuma bu çağrıdan önce başlamış olabilir; bitmesini bekleyip yeniden oku
    await dataInflight.catch(() => undefined);
  }

  if (!dataInflight) {
    dataInflight = fetchData().finally(() => {
      dataInflight = null;
    });
  }

  try {
    return await dataInflight;
  } catch (error) {
    // Okuma başarısızsa ve elde eski veri varsa onunla devam et
    if (!force && dataCache) {
      console.warn('Sheets okunamadı, önbellekteki eski veri kullanılıyor');
      return dataCache.data;
    }
    throw error;
  }
}

export async function getMainRows(options: { maxAgeMs?: number; force?: boolean } = {}): Promise<SheetRows> {
  return (await getSheetData(options)).main;
}

export function invalidateSheetData() {
  dataCache = null;
}

/** Yazılmış ama henüz okumada görünmeyen verileri unutur (sıfırlama sonrası). */
export function clearRecentWrites() {
  recentCellWrites.clear();
  recentLogRows.length = 0;
}

// ---------------------------------------------------------------------------
// Toplu yazma (ana sayfa hücreleri + kayıt satırları tek istekte)
// ---------------------------------------------------------------------------

type PendingWrite =
  | { kind: 'cell'; key: string; row: number; col: number; value: string; resolve: () => void; reject: (e: unknown) => void }
  | { kind: 'log'; row: string[]; resolve: () => void; reject: (e: unknown) => void };

const writeQueue: PendingWrite[] = [];
let flushRunning = false;
let lastFlushAt = 0;

function enqueue(write: PendingWrite) {
  writeQueue.push(write);
  if (!flushRunning) {
    void runFlushLoop();
  }
}

/**
 * Ana sayfadaki tek bir hücreyi yazar. Yazma kuyruğa alınır ve o sırada
 * bekleyen diğer yazmalarla birlikte tek istekte gönderilir.
 * Promise, veri Sheets'e kaydedildiğinde çözülür.
 */
export function writeMainCell(row: number, col: number, value: string): Promise<void> {
  const key = `${row}:${col}`;
  // Aynı örnekteki eşzamanlı istekler bu yazmayı hemen görsün
  recentCellWrites.set(key, { row, col, value, expiresAt: Number.POSITIVE_INFINITY });
  if (dataCache) setCell(dataCache.data.main, row, col, value);

  return new Promise<void>((resolve, reject) => {
    enqueue({ kind: 'cell', key, row, col, value, resolve, reject });
  });
}

/** "Yoklama Kayıtları" sayfasına bir satır ekler (toplu gönderilir). */
export function appendLogRow(row: string[]): Promise<void> {
  const entry = { row, expiresAt: Number.POSITIVE_INFINITY };
  recentLogRows.push(entry);
  if (dataCache) dataCache.data.log.push(row.slice());

  return new Promise<void>((resolve, reject) => {
    enqueue({
      kind: 'log',
      row,
      resolve: () => {
        entry.expiresAt = Date.now() + RECENT_WRITE_TTL_MS;
        resolve();
      },
      reject: (error) => {
        const index = recentLogRows.indexOf(entry);
        if (index >= 0) recentLogRows.splice(index, 1);
        reject(error);
      }
    });
  });
}

// Tüm değerler metin olarak yazılır: sayı olarak yazılan zaman damgası okunurken
// "1,79E+12" gibi biçimlenip karşılaştırmaları bozabilir
function toCellData(value: string): sheets_v4.Schema$CellData {
  return { userEnteredValue: { stringValue: value } };
}

async function runFlushLoop() {
  flushRunning = true;
  try {
    while (writeQueue.length > 0) {
      const wait = lastFlushAt + MIN_FLUSH_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);

      const batch = writeQueue.splice(0, writeQueue.length);
      // Aynı hücreye birden fazla yazma varsa sonuncusu geçerli
      const latestCells = new Map<string, { row: number; col: number; value: string }>();
      for (const write of batch) {
        if (write.kind === 'cell') latestCells.set(write.key, write);
      }
      const logRows = batch.flatMap(write => (write.kind === 'log' ? [write.row] : []));

      try {
        const meta = await getSheetMeta();
        const requests: sheets_v4.Schema$Request[] = [];
        for (const cell of latestCells.values()) {
          requests.push({
            updateCells: {
              start: { sheetId: meta.mainSheetId, rowIndex: cell.row, columnIndex: cell.col },
              rows: [{ values: [{ userEnteredValue: { stringValue: cell.value } }] }],
              fields: 'userEnteredValue'
            }
          });
        }
        if (logRows.length > 0) {
          requests.push({
            appendCells: {
              sheetId: meta.logSheetId,
              rows: logRows.map(row => ({ values: row.map(value => toCellData(value)) })),
              fields: 'userEnteredValue'
            }
          });
        }

        await withRetry(() =>
          getSheets().spreadsheets.batchUpdate({
            spreadsheetId: getSpreadsheetId(),
            requestBody: { requests }
          })
        );
        lastFlushAt = Date.now();
        for (const write of batch) {
          if (write.kind === 'cell') {
            const recent = recentCellWrites.get(write.key);
            if (recent && recent.value === write.value) {
              recent.expiresAt = Date.now() + RECENT_WRITE_TTL_MS;
            }
          }
          write.resolve();
        }
        console.log(`Sheets toplu yazma: ${latestCells.size} hücre, ${logRows.length} kayıt satırı`);
      } catch (error) {
        lastFlushAt = Date.now();
        console.error('Sheets toplu yazma hatası:', error);
        for (const write of batch) {
          if (write.kind === 'cell') {
            const recent = recentCellWrites.get(write.key);
            if (recent && recent.value === write.value) {
              recentCellWrites.delete(write.key);
            }
          }
          write.reject(error);
        }
        // Önbellekteki iyimser değerler artık güvenilir değil
        invalidateSheetData();
      }
    }
  } finally {
    flushRunning = false;
  }
}
