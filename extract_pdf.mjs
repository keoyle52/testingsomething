import fs from 'fs';
const buf = fs.readFileSync('C:/Users/Berat/Desktop/Terminal/Build Your One-Person On-Chain Finance Business with SoSoValue _ AKINDO.pdf');
const txt = buf.toString('latin1').replace(/[^\x20-\x7E\n]/g, ' ').replace(/ {3,}/g, ' ');
// Pull readable lines
const lines = txt.split('\n').map(l => l.trim()).filter(l => l.length > 15 && /[a-zA-Z]/.test(l));
console.log(lines.slice(0, 300).join('\n'));
