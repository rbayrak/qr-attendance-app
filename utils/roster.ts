// utils/roster.ts (yalnızca sunucuda kullanılır)
// Ana sayfadaki öğrenci listesi: numara B, ad C sütununda; 1. hafta D sütununda.

import type { SheetRows } from '@/utils/sheets';
import { matchStudentId } from '@/utils/studentId';

export const STUDENT_ID_COLUMN = 1;
export const STUDENT_NAME_COLUMN = 2;
export const FIRST_WEEK_COLUMN = 3;
export const MAX_WEEK = 16;

export function rowStudentId(rows: SheetRows, rowIndex: number): string {
  return String(rows[rowIndex]?.[STUDENT_ID_COLUMN] ?? '').trim();
}

export function rowStudentName(rows: SheetRows, rowIndex: number): string {
  return String(rows[rowIndex]?.[STUDENT_NAME_COLUMN] ?? '');
}

/**
 * Girilen numaranın satırını bulur (yoksa -1). "ç23051608" / "C23051608" gibi
 * yazımlar listedeki "Ç23051608" ile eşleşir; asıl numara için rowStudentId kullanılır.
 */
export function findStudentRow(rows: SheetRows, input: string): number {
  const ids: string[] = [];
  for (let i = 1; i < rows.length; i++) ids.push(rowStudentId(rows, i));
  const id = matchStudentId(input, ids);
  if (id === null) return -1;
  return ids.indexOf(id) + 1;
}

export function weekColumn(week: number): number {
  return FIRST_WEEK_COLUMN + week - 1;
}

export function hasAttended(rows: SheetRows, rowIndex: number, week: number): boolean {
  const value = rows[rowIndex]?.[weekColumn(week)];
  return typeof value === 'string' && value.includes('VAR');
}

/** Öğrenci numarası -> ad (uyarı metinleri için) */
export function nameLookup(rows: SheetRows): (id: string) => string {
  const names = new Map<string, string>();
  for (let i = 1; i < rows.length; i++) {
    const id = rowStudentId(rows, i);
    if (id) names.set(id, rowStudentName(rows, i));
  }
  return (id: string) => names.get(id) ?? '';
}
