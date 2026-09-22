const { google } = require('googleapis');
const path = require('path');

const SPREADSHEET_ID = process.env.SHEET_ID || '1ZiRo9z5-GXRlN-rDFVZwUwN2T9KfnQTqp7joD5rcNLo';

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function main() {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  console.log('Tabs:', meta.data.sheets.map((s) => s.properties.title).join(', '));
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!A1:C20',
  });
  console.log('Sheet1 A1:C20 =');
  console.log(JSON.stringify(res.data.values || [], null, 2));
}

main().catch((e) => {
  console.error('LỖI:', e.errors ? JSON.stringify(e.errors) : e.message);
  process.exit(1);
});
