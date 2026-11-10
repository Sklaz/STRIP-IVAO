import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

export const AURORA_CALLSIGN = /^[A-Z0-9]{2,7}$/;
export const MAX_AURORA_CALLSIGNS = 200;
const SQUAWK = /^[0-7]{4}$/;
const ALTITUDE_LABELS = new Map([['-1','APP'],['-2','LND'],['-3','GA']]);

function label(value) {
  const text = value?.trim() ?? '';
  return text === '-' || text.length > 32 ? '' : text;
}

function readPosition(fields) {
  const [observed,assigned,waypoint,altitude,speed] = fields.slice(8,13);
  const altitudeLabel = label(altitude);
  return {callsign:fields[1],observedSquawk:SQUAWK.test(observed) ? observed : '',
    squawk:SQUAWK.test(assigned) ? assigned : '',waypoint:label(waypoint),
    assigned:ALTITUDE_LABELS.get(altitudeLabel) ?? altitudeLabel,
    speed:label(speed),gate:label(fields[22])};
}

export async function readAurora(callsigns,port = 1130) {
  const socket = createConnection({host:'127.0.0.1',port});
  socket.setEncoding('utf8');
  const lines = createInterface({input:socket,crlfDelay:Infinity});
  const responses = lines[Symbol.asyncIterator]();
  const deadline = setTimeout(() => socket.destroy(new Error('Réponse Aurora trop lente.')),5000);
  async function request(command,callsign) {
    socket.write('#' + command + (callsign ? ';' + callsign : '') + '\r\n');
    while (true) {
      const {value,done} = await responses.next();
      if (done) throw new Error('Aurora a fermé la liaison.');
      const fields = value.split(';');
      if (fields[0] === '$' + command) return null;
      if (fields[0] === '#' + command && (!callsign || fields[1] === callsign)) return fields;
    }
  }
  try {
    const connection = await request('CONN');
    if (!connection) throw new Error('Aurora a refusé la lecture de sa position.');
    const station = label(connection[1]);
    if (!callsigns.length) return {station,strips:[]};
    const traffic = await request('TR');
    if (!traffic) throw new Error('Aurora a refusé la lecture du trafic.');
    const inRange = new Set(traffic.slice(1));
    const strips = [];
    for (const callsign of new Set(callsigns)) {
      if (!inRange.has(callsign)) continue;
      const fields = await request('TRPOS',callsign);
      if (fields?.length >= 13) strips.push(readPosition(fields));
    }
    return {station,strips};
  } finally {
    clearTimeout(deadline);
    lines.close();
    socket.destroy();
  }
}
