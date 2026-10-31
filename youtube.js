// Conexión con la API de YouTube (canal Stick Sapiens).
// Uso: node scripts/youtube.js --configurar   (abre Google una vez para dar permiso; guarda YOUTUBE_REFRESH_TOKEN en .env)
//      node scripts/youtube.js --probar       (muestra el canal y sus suscriptores)
//      node scripts/youtube.js --subir <escena> <fecha ISO|privado>
//        Video: salida/<escena>.mp4 · Texto: marca/textos/<escena>-youtube.txt (1.ª línea título, el resto descripción)
// El cliente OAuth va en youtube-cliente.json (app de escritorio de Google Cloud). Los tokens nunca se imprimen.
// Ojo: mientras Google no audite el proyecto, todo lo subido por API queda en privado aunque tenga fecha.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { leerEnv } = require('./meta.js');

const RAIZ = path.join(__dirname, '..');
const ENV = path.join(RAIZ, '.env');
const API = 'https://www.googleapis.com/youtube/v3';
const ALCANCES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube';
const LISTA = 'De Sarajevo a la caída del Muro';

function cliente() {
  const json = JSON.parse(fs.readFileSync(path.join(RAIZ, 'youtube-cliente.json'), 'utf8'));
  return json.installed || json.web;
}

function guardarEnv(clave, valor) {
  let texto = fs.readFileSync(ENV, 'utf8');
  const linea = `${clave}=${valor}`;
  const re = new RegExp(`^${clave}=.*$`, 'm');
  texto = re.test(texto) ? texto.replace(re, linea) : `${texto.replace(/\s*$/, '')}\n${linea}\n`;
  fs.writeFileSync(ENV, texto);
}

async function pedirToken(parametros) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams(parametros) });
  const json = await r.json();
  if (json.error) throw new Error(`Google: ${json.error_description || json.error}`);
  return json;
}

// Abre el navegador, recibe el código en un servidor local y lo canjea por el refresh token
async function configurar() {
  const { client_id, client_secret } = cliente();
  const servidor = http.createServer();
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${servidor.address().port}`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id, redirect_uri: redirect, response_type: 'code', scope: ALCANCES, access_type: 'offline', prompt: 'consent',
  })}`;
  const codigo = await new Promise((resolver, rechazar) => {
    servidor.on('request', (req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      if (!q.get('code') && !q.get('error')) return res.end();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(q.get('code') ? '<h2>Listo: Stick Sapiens conectado a YouTube. Ya puedes cerrar esta pestaña.</h2>' : '<h2>Permiso cancelado.</h2>');
      servidor.close();
      q.get('code') ? resolver(q.get('code')) : rechazar(new Error(`Google: ${q.get('error')}`));
    });
    console.log('YouTube: se abre el navegador para dar permiso (elige el canal Stick Sapiens).');
    execFile('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]);
  });
  const tokens = await pedirToken({ code: codigo, client_id, client_secret, redirect_uri: redirect, grant_type: 'authorization_code' });
  if (!tokens.refresh_token) throw new Error('Google no devolvió refresh token; vuelve a correr --configurar.');
  guardarEnv('YOUTUBE_REFRESH_TOKEN', tokens.refresh_token);
  console.log('YouTube: permiso guardado en .env.');
  await probar();
}

async function acceso() {
  const { client_id, client_secret } = cliente();
  const refresh = leerEnv().YOUTUBE_REFRESH_TOKEN;
  if (!refresh) throw new Error('Falta YOUTUBE_REFRESH_TOKEN: corre primero node scripts/youtube.js --configurar');
  const { access_token } = await pedirToken({ refresh_token: refresh, client_id, client_secret, grant_type: 'refresh_token' })
    .catch((e) => { throw new Error(`${e.message}. Si la app sigue en "Prueba", el permiso vence a los 7 días: corre --configurar otra vez.`); });
  return access_token;
}

async function yt(token, ruta, opciones = {}) {
  const r = await fetch(`${API}/${ruta}`, {
    ...opciones,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opciones.headers },
  });
  const json = await r.json();
  if (json.error) throw new Error(`YouTube (${ruta.split('?')[0]}): ${json.error.message}`);
  return json;
}

async function probar() {
  const token = await acceso();
  const { items } = await yt(token, 'channels?part=snippet,statistics&mine=true');
  const c = items?.[0];
  if (!c) throw new Error('La cuenta autorizada no tiene canal: en --configurar elige el canal Stick Sapiens.');
  console.log(`YouTube: ${c.snippet.title} · ${c.statistics.subscriberCount} suscriptores · ${c.statistics.videoCount} videos`);
}

// Busca la lista de la serie y, si no existe, la crea
async function listaDeLaSerie(token) {
  const { items } = await yt(token, 'playlists?part=snippet&mine=true&maxResults=50');
  const hallada = items.find((l) => l.snippet.title === LISTA);
  if (hallada) return hallada.id;
  const nueva = await yt(token, 'playlists?part=snippet,status', {
    method: 'POST',
    body: JSON.stringify({ snippet: { title: LISTA, defaultLanguage: 'es' }, status: { privacyStatus: 'public' } }),
  });
  return nueva.id;
}

async function subir() {
  const [escena, fecha] = process.argv.slice(3);
  if (!escena || !fecha) throw new Error('Uso: --subir <escena> <fecha ISO|privado>');
  const archivo = path.join(RAIZ, 'salida', `${escena}.mp4`);
  const [titulo, ...resto] = fs.readFileSync(path.join(RAIZ, 'marca', 'textos', `${escena}-youtube.txt`), 'utf8').trim().split(/\r?\n/);
  const cuando = fecha === 'privado' ? null : new Date(fecha);
  if (cuando && !(cuando > Date.now() + 20 * 60000)) throw new Error('La fecha debe ser válida y al menos 20 minutos en el futuro.');
  const token = await acceso();
  const datos = fs.readFileSync(archivo);
  // Subida reanudable: primero los datos del video, luego el archivo
  const inicio = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(datos.length),
    },
    body: JSON.stringify({
      snippet: { title: titulo, description: resto.join('\n').trim(), categoryId: '27', defaultLanguage: 'es', defaultAudioLanguage: 'es' },
      status: {
        privacyStatus: 'private', ...(cuando && { publishAt: cuando.toISOString() }),
        selfDeclaredMadeForKids: false, containsSyntheticMedia: false,
      },
    }),
  });
  if (!inicio.ok) throw new Error(`YouTube (inicio de subida): ${(await inicio.json()).error?.message}`);
  const r = await fetch(inicio.headers.get('location'), { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: datos });
  const video = await r.json();
  if (video.error) throw new Error(`YouTube (subida): ${video.error.message}`);
  await yt(token, 'playlistItems?part=snippet', {
    method: 'POST',
    body: JSON.stringify({ snippet: { playlistId: await listaDeLaSerie(token), resourceId: { kind: 'youtube#video', videoId: video.id } } }),
  });
  console.log(`YouTube: ${video.id} subido ${cuando ? `y programado para ${cuando.toLocaleString('es-CO')}` : 'en privado'} · lista "${LISTA}".`);
  console.log('YouTube: "Vídeo relacionado" no está en la API; se pone a mano en Studio.');
}

if (require.main === module) {
  const accion = { '--configurar': configurar, '--probar': probar, '--subir': subir }[process.argv[2]];
  if (!accion) {
    console.log('Uso: node scripts/youtube.js --configurar | --probar | --subir <escena> <fecha ISO|privado>');
    process.exit(1);
  }
  accion().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
