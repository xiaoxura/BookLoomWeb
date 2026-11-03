import fs from 'node:fs';
import iconv from 'iconv-lite';

const WORDS =
  '夜色像一块湿透的布慢慢盖住了整座城他站在桥头听见远处传来汽笛声一声长一声短风从海面吹来带着咸味和铁锈的味道灯塔的光穿过雾照在礁石上碎成一片一片';
const sentence = (n) => {
  let out = '';
  for (let i = 0; i < n; i++) out += WORDS[(i * 7 + n) % WORDS.length];
  return out + '。';
};

const chapters = 1280;
const pieces = ['内容简介\n这是一个用于性能测试的长篇故事。'];
for (let i = 1; i <= chapters; i++) {
  pieces.push(`第${i}章 第${i}次潮汐`);
  for (let j = 0; j < 16; j++) pieces.push(sentence(150 + ((i * 13 + j * 7) % 80)));
}
const text = pieces.join('\n\n');
fs.writeFileSync('samples/big-gbk.txt', iconv.encode(text, 'gbk'));
console.log(`${text.length} chars → ${(fs.statSync('samples/big-gbk.txt').size / 1024 / 1024).toFixed(2)} MB`);
