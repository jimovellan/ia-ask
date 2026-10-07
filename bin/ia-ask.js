#!/usr/bin/env node
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- Markdown mínimo para consola, línea a línea (todo en verde salvo el código) ---
const VERDE = '\x1b[32m', AMARILLO = '\x1b[33m', TENUE = '\x1b[2m', RESET = '\x1b[0m';

function enLinea(texto) {
  // Separar `código` para no aplicar formato dentro
  return texto.split(/(`[^`]+`)/).map((parte) => {
    if (/^`[^`]+`$/.test(parte)) return `${AMARILLO}${parte.slice(1, -1)}${VERDE}`;
    return parte
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `\x1b[1m${a ?? b}\x1b[22m`)
      .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1\x1b[3m$2\x1b[23m')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '\x1b[4m$1\x1b[24m (\x1b[2m$2\x1b[22m)');
  }).join('');
}

function crearRenderizador() {
  let enCodigo = false;
  return (linea) => {
    const valla = linea.match(/^\s*(```|~~~)\s*(\S*)/);
    if (valla) {
      enCodigo = !enCodigo;
      return enCodigo ? `${TENUE}┌── ${valla[2] || 'código'}${RESET}` : `${TENUE}└──${RESET}`;
    }
    if (enCodigo) return `${TENUE}│${RESET} ${AMARILLO}${linea}${RESET}`;

    let m;
    if ((m = linea.match(/^(#{1,6})\s+(.*)/))) return `${VERDE}\x1b[1;4m${m[2].replace(/\*\*/g, '')}${RESET}`;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(linea)) return `${TENUE}${'─'.repeat(40)}${RESET}`;
    if ((m = linea.match(/^(\s*)[*+-]\s+(.*)/))) return `${VERDE}${m[1]}  • ${enLinea(m[2])}${RESET}`;
    if ((m = linea.match(/^\s*>\s?(.*)/))) return `${TENUE}│${RESET} ${VERDE}${enLinea(m[1])}${RESET}`;
    return `${VERDE}${enLinea(linea)}${RESET}`;
  };
}

// --- Configuración en ~/.config/ia-ask (se edita con `ia-ask --settings`) ---
const CONFIG_DIR = path.join(os.homedir(), '.config', 'ia-ask');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PUERTO_OLLAMA = '11434';
const URL_DEFECTO = `http://localhost:${PUERTO_OLLAMA}`;

function leerConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

async function configurar() {
  const config = leerConfig();
  const actual = config.host || URL_DEFECTO;
  const entrada = readline.createInterface({ input: process.stdin, output: process.stdout });
  const resp = (await new Promise((resolve) => entrada.question(`URL del servidor Ollama [${actual}]: `, resolve))).trim();
  entrada.close();

  let host = resp || actual;
  if (!/^https?:\/\//i.test(host)) host = `http://${host}`;
  let url;
  try { url = new URL(host); } catch {
    console.error(`\x1b[31mURL no válida: ${host}\x1b[0m`);
    process.exit(1);
  }
  // Sin puerto explícito se usa el de Ollama
  if (!/:\d+$/.test(url.host)) url.port = PUERTO_OLLAMA;

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ ...config, host: url.origin }, null, 2)}\n`);
  console.log(`Guardado en ${CONFIG_FILE}: ${url.origin}`);
}

if (process.argv.includes('--settings')) {
  await configurar();
  process.exit(0);
}

const HOST = process.env.OLLAMA_HOST || leerConfig().host || URL_DEFECTO;
const DEFAULT_MODEL = 'gemma:2b';
let MODEL = process.env.OLLAMA_MODEL || DEFAULT_MODEL;

const messages = [];
let controller = null;
let rl = null;

// --- Herramientas: las de lectura se ejecutan solas; las que cambian algo piden confirmación ---
const WINDOWS = process.platform === 'win32';
const SHELL = WINDOWS ? 'PowerShell' : 'bash';
const MAX_SALIDA = 2000; // caracteres de salida que se devuelven al modelo
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192; // las definiciones de tools ocupan contexto
let usarTools = true; // se desactiva si el modelo no las admite

const tool = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
// Las tools y las instrucciones van en inglés: los modelos pequeños las usan mucho mejor así
const TOOLS = [
  tool('list_directory', 'List the files and folders in a directory on the user\'s computer', {
    path: { type: 'string', description: 'Directory path; "." for the current folder' },
  }, ['path']),
  tool('read_file', 'Read a text file on the user\'s computer and return its numbered lines', {
    path: { type: 'string', description: 'File path' },
    start: { type: 'integer', description: 'First line to read (default 1)' },
    lines: { type: 'integer', description: 'Number of lines to read (default 100)' },
  }, ['path']),
  tool('edit_file', 'Replace an exact snippet in a file. If "find" is empty, create or overwrite the file with "replace"', {
    path: { type: 'string', description: 'File path' },
    find: { type: 'string', description: 'Exact text to replace; must appear exactly once' },
    replace: { type: 'string', description: 'New text' },
  }, ['path', 'find', 'replace']),
  tool('run_command', `Run a command in ${SHELL} on the user's computer and return its output`, {
    command: { type: 'string', description: 'Command to run' },
  }, ['command']),
];

// Se genera en cada petición para que la fecha y la carpeta estén al día
const sistema = () => `You are an assistant running in the user's console, with real access to their computer through tools.
OS: ${WINDOWS ? 'Windows' : process.platform}; commands run in ${SHELL}.
Current folder: ${process.cwd()}
Date and time: ${new Date().toLocaleString('es-ES')}

Tools:
- list_directory and read_file: use them freely to look at files. Never ask the user for a file's path or contents: read it yourself.
- edit_file: to create or modify files, instead of commands.
- run_command: for everything else. One simple, non-interactive command at a time.
Rules:
- Use tools only when you need information from the computer or the user asks you to do something on it; otherwise answer directly.
- Call tools through the tool-calling mechanism; never write the call as text or JSON.
- The user confirms every edit and command; if they reject one, do not retry it: ask what they prefer.
- The user does NOT see tool results: summarize what matters, briefly.
- The user writes in Spanish. Always answer in Spanish.`;

const recortar = (texto) => (texto.length > MAX_SALIDA ? `${texto.slice(0, MAX_SALIDA)}\n… (output truncated)` : texto);
const confirmar = async (pregunta) => (await new Promise((resolve) => rl.question(`${pregunta} (s/N) `, resolve))).trim().toLowerCase() === 's';

// Los resultados que se devuelven al modelo también van en inglés
function listarDirectorio({ path: ruta = '.' }) {
  const entradas = fs.readdirSync(ruta, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? `${e.name}/` : `${e.name} (${fs.statSync(path.join(ruta, e.name)).size} bytes)`));
  return recortar(entradas.join('\n') || '(empty directory)');
}

function leerArchivo({ path: ruta, start: desde = 1, lines: lineas = 100 }) {
  const todas = fs.readFileSync(ruta, 'utf8').split(/\r?\n/);
  const ini = Math.max(1, Number(desde) || 1);
  const fin = Math.min(todas.length, ini + (Number(lineas) || 100) - 1);
  const texto = todas.slice(ini - 1, fin).map((l, i) => `${ini + i}: ${l}`).join('\n');
  return `${recortar(texto)}\n(lines ${ini}-${fin} of ${todas.length})`;
}

async function editarArchivo({ path: ruta, find: buscar = '', replace: reemplazar = '' }) {
  const existe = fs.existsSync(ruta);
  const actual = existe ? fs.readFileSync(ruta, 'utf8') : '';
  if (buscar) {
    if (!existe) return `File ${ruta} does not exist.`;
    const veces = actual.split(buscar).length - 1;
    if (veces !== 1) return `The text to find appears ${veces} times in ${ruta}; it must appear exactly once.`;
  }

  process.stdout.write(`\x1b[33mLa IA quiere ${buscar ? 'editar' : existe ? 'sobrescribir' : 'crear'}:\x1b[0m \x1b[1m${ruta}\x1b[0m\n`);
  const pintar = (texto, color, signo) => texto && process.stdout.write(`${texto.split('\n').map((l) => `${color}${signo} ${l}${RESET}`).join('\n')}\n`);
  pintar(buscar, '\x1b[31m', '-');
  pintar(reemplazar, '\x1b[32m', '+');
  if (!(await confirmar('¿Aplicar el cambio?'))) return null;

  fs.mkdirSync(path.dirname(path.resolve(ruta)), { recursive: true });
  fs.writeFileSync(ruta, buscar ? actual.replace(buscar, () => reemplazar) : reemplazar);
  return `File ${ruta} ${buscar ? 'edited' : existe ? 'overwritten' : 'created'}.`;
}

async function ejecutarComando({ command: comando }) {
  process.stdout.write(`\x1b[33mLa IA quiere ejecutar:\x1b[0m \x1b[1m${comando}\x1b[0m\n`);
  if (!(await confirmar('¿Ejecutar?'))) return null;
  const r = WINDOWS
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${comando}`], { encoding: 'utf8', timeout: 60000 })
    : spawnSync(comando, { shell: true, encoding: 'utf8', timeout: 60000 });
  if (r.error) return `Error running command: ${r.error.message}`;
  return `${recortar(`${r.stdout}${r.stderr}`.trim() || '(no output)')}\n(exit code ${r.status})`;
}

const HERRAMIENTAS = {
  list_directory: listarDirectorio,
  read_file: leerArchivo,
  edit_file: editarArchivo,
  run_command: ejecutarComando,
};
const SOLO_LECTURA = new Set(['list_directory', 'read_file']);

// El resultado no se muestra al usuario: solo se guarda en el contexto para el modelo
async function usarHerramienta({ function: { name, arguments: args } }) {
  if (typeof args === 'string') try { args = JSON.parse(args); } catch {}
  const fn = HERRAMIENTAS[name];
  if (!fn || typeof args !== 'object' || args === null) return `Invalid tool or arguments: ${name}`;

  if (SOLO_LECTURA.has(name)) process.stdout.write(`${TENUE}· ${name} ${args.path ?? ''}${RESET}\n`);
  try {
    const resultado = await fn(args);
    if (resultado === null) {
      process.stdout.write(`${TENUE}Cancelado.${RESET}\n\n`);
      return 'The user rejected this action.';
    }
    if (!SOLO_LECTURA.has(name)) process.stdout.write('\n');
    return resultado;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

function salir() {
  controller?.abort();
  process.stdout.write('\x1b[0m\x1b[?25h\n\x1b[2mHasta luego.\x1b[0m\n');
  rl?.close();
  process.exit(0);
}

process.stdin.on('keypress', (_, key) => {
  if (key && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) salir();
});

async function elegirModelo() {
  let modelos;
  try {
    const res = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(5000) });
    modelos = (await res.json()).models.map((m) => m.name);
  } catch (err) {
    console.error(`\x1b[31mNo se pudo obtener la lista de modelos (${err.message}). Se usa ${MODEL}.\x1b[0m\n`);
    return;
  }
  if (!modelos.length) return;

  let sel = Math.max(0, modelos.indexOf(DEFAULT_MODEL));
  const pintar = () => {
    for (const [i, m] of modelos.entries()) {
      readline.clearLine(process.stdout, 0);
      process.stdout.write(i === sel ? `\x1b[1;32m❯ ${m}\x1b[0m\n` : `  ${m}\n`);
    }
  };

  console.log('Elige modelo (↑/↓ y Enter):');
  process.stdout.write('\x1b[?25l'); // ocultar cursor
  pintar();
  process.stdin.resume();

  await new Promise((resolve) => {
    const onKey = (_, key) => {
      if (!key) return;
      if (key.name === 'up') sel = (sel - 1 + modelos.length) % modelos.length;
      else if (key.name === 'down') sel = (sel + 1) % modelos.length;
      else if (key.name === 'return') {
        process.stdin.off('keypress', onKey);
        return resolve();
      } else return;
      readline.moveCursor(process.stdout, 0, -modelos.length);
      pintar();
    };
    process.stdin.on('keypress', onKey);
  });

  process.stdout.write('\x1b[?25h\n'); // mostrar cursor
  MODEL = modelos[sel];
}

async function preguntar(texto) {
  messages.push({ role: 'user', content: texto });
  // Mientras el modelo pida herramientas, se ejecutan y se le devuelve el resultado
  for (;;) {
    const { respuesta, llamadas } = await pedirRespuesta();
    messages.push({ role: 'assistant', content: respuesta, ...(llamadas.length && { tool_calls: llamadas }) });
    if (!llamadas.length) return;
    for (const llamada of llamadas) messages.push({ role: 'tool', content: await usarHerramienta(llamada) });
  }
}

async function pedirRespuesta() {
  controller = new AbortController();
  // Ollama 0.3.x no combina tools con streaming: con tools la respuesta llega en un solo bloque
  const cuerpo = usarTools
    ? { model: MODEL, messages: [{ role: 'system', content: sistema() }, ...messages], tools: TOOLS, stream: false, options: { num_ctx: NUM_CTX } }
    : { model: MODEL, messages, stream: true };

  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
    signal: controller.signal,
  });
  if (!res.ok) {
    const error = await res.text();
    if (usarTools && error.includes('does not support tools')) {
      usarTools = false;
      process.stdout.write(`${TENUE}(${MODEL} no admite herramientas; se continúa sin ellas)${RESET}\n`);
      return pedirRespuesta();
    }
    throw new Error(`HTTP ${res.status}: ${error}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let respuesta = '';
  const llamadas = [];

  // Cada línea se pinta en cuanto está completa; la cabecera solo si hay texto
  const renderizar = crearRenderizador();
  let lineaActual = '';
  const procesarLinea = (linea) => process.stdout.write(`${renderizar(linea)}\n`);
  const procesarJson = (linea) => {
    if (!linea.trim()) return;
    const data = JSON.parse(linea);
    if (data.error) throw new Error(data.error);
    llamadas.push(...(data.message?.tool_calls ?? []));
    const trozo = data.message?.content ?? '';
    if (!trozo) return;
    if (!respuesta) process.stdout.write('\x1b[1;32mIA>\x1b[0m\n');
    respuesta += trozo;
    const partes = (lineaActual + trozo).split('\n');
    lineaActual = partes.pop();
    partes.forEach(procesarLinea);
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lineas = buffer.split('\n');
    buffer = lineas.pop();
    lineas.forEach(procesarJson);
  }
  procesarJson(buffer);
  if (lineaActual) procesarLinea(lineaActual);
  if (respuesta) process.stdout.write('\n');
  controller = null;
  return { respuesta, llamadas };
}

// Solo se pregunta en una terminal interactiva y si no se fijó OLLAMA_MODEL
if (process.stdin.isTTY && !process.env.OLLAMA_MODEL) await elegirModelo();

rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('SIGINT', salir);

console.log(`\x1b[2mChat con ${MODEL} en ${HOST} — pulsa ESC para salir.\x1b[0m\n`);
rl.setPrompt('\x1b[1;97mTú>\x1b[22m ');
rl.prompt();

// El iterador encola las líneas que lleguen mientras se espera una respuesta
for await (const linea of rl) {
  process.stdout.write('\x1b[0m');
  const texto = linea.trim();
  if (texto) {
    if (!process.stdin.isTTY) process.stdout.write(`${texto}\n`);
    const antes = messages.length;
    try {
      await preguntar(texto);
    } catch (err) {
      messages.length = antes; // descartar la pregunta fallida y lo que generó
      console.error(`\x1b[0m\x1b[31mError: ${err.message}\x1b[0m\n`);
    }
  }
  rl.prompt();
}
process.stdout.write('\x1b[0m\n');
