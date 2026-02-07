import { readFileSync, writeFileSync } from 'fs';

const content = readFileSync('docs/cadre-architecture.md', 'utf8');
const lines = content.split('\n');

// 1. Update CadreNodeConfig network section
const netStart = lines.findIndex(l => l.trim() === '// Network configuration');
if (netStart >= 0) {
  const netEnd = lines.indexOf('  };', netStart);
  if (netEnd >= 0) {
    const newNetLines = [
      '  // Network configuration',
      '  network: {',
      '    listenAddrs?: string[];       // Addresses to listen on',
      '    announceAddrs?: string[];     // Addresses to advertise',
      '    relayAddrs?: string[];        // Relay servers to connect through',
      '    enableRelay?: boolean;        // Enable circuit relay (default: true for storage profile)',
      '    transports?: Libp2pTransports; // Custom libp2p transports (default: TCP + relay)',
      '  };'
    ];
    lines.splice(netStart, netEnd - netStart + 1, ...newNetLines);
    console.log('Updated CadreNodeConfig network section');
  }
}

// 2. Update React Native example to include transport config
const rnStart = lines.findIndex(l => l.trim() === '#### React Native (Mobile)');
if (rnStart >= 0) {
  const rnCodeStart = lines.indexOf('```typescript', rnStart);
  const rnCodeEnd = lines.indexOf('```', rnCodeStart + 1);
  if (rnCodeStart >= 0 && rnCodeEnd >= 0) {
    const newRnCode = [
      '```typescript',
      "import { CadreNode } from '@sereus/cadre-core';",
      "import { RNRawStorage } from '@optimystic/db-p2p-storage-rn';",
      "import { webSockets } from '@libp2p/websockets';",
      "import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';",
      '',
      'const node = new CadreNode({',
      '  // ...',
      "  profile: 'transaction',",
      "  strandFilter: { mode: 'sAppId', sAppId: 'com.example.myapp' },",
      '  storage: {',
      '    provider: (strandId) => new RNRawStorage(strandId)',
      '  },',
      '  network: {',
      '    transports: [webSockets(), circuitRelayTransport()],',
      '    listenAddrs: []  // RN nodes typically cannot listen',
      '  }',
      '});',
      '```'
    ];
    lines.splice(rnCodeStart, rnCodeEnd - rnCodeStart + 1, ...newRnCode);
    console.log('Updated RN example');
  }
}

// 3. Update Phase 5 checklist — mark WebSocket transport as done
const wsIdx = lines.findIndex(l => l.includes('WebSocket transport for libp2p'));
if (wsIdx >= 0) {
  lines[wsIdx] = lines[wsIdx].replace('- [ ]', '- [x]');
  console.log('Marked WebSocket transport TODO as done');
}

writeFileSync('docs/cadre-architecture.md', lines.join('\n'));
console.log('Done');

