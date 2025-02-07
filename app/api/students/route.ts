// app/api/students/route.ts
interface SheetRow {
    [index: number]: string;
  }
  
  export async function GET() {
    const data = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${process.env.SPREADSHEET_ID}/values/A:C`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.TEACHER_ACCESS_TOKEN}`
        }
      }
    ).then(res => res.json());
  
    return Response.json(data.values.slice(1).map((row: SheetRow) => ({
      studentId: row[1]?.toString(),
      studentName: row[2]?.toString()
    })));
  }