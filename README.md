# ia-ask

Chat de consola contra Ollama. Mantiene el historial de la conversación y, con modelos que lo admiten, puede leer archivos, editarlos y ejecutar comandos (con confirmación). **ESC** para salir.

## Instalar

Directamente desde GitHub:

```sh
npm install -g github:jimovellan/ia-ask
```

O desde una copia local del repo:

```sh
npm run instalar
```

## Usar

```sh
ia-ask
```

## Configurar

```sh
ia-ask --settings
```

Pide la URL del servidor Ollama (por defecto `http://localhost:11434`; si no indicas puerto se usa el `11434`) y la guarda en `~/.config/ia-ask/config.json`.

Variables opcionales, que tienen prioridad sobre la configuración: `OLLAMA_HOST`, `OLLAMA_MODEL` (por defecto `gemma:2b`) y `OLLAMA_NUM_CTX` (por defecto `8192`).
