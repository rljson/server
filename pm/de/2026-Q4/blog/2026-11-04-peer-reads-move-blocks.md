<!--
@license
Copyright (c) rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Peer-Reads holen Blöcke und behalten keinen davon

## Motivation

- `@rljson/bs` speichert und überträgt jeden Blob jetzt als Blöcke mit
  inhaltsbasierten Grenzen. Ein Client liest erst die Blockliste eines Blobs,
  dann seine Blöcke, und ein Peer, der einen Block schon hat, kann ihn
  liefern, egal mit welchem Blob er kam.
- Peer-Reads fragten einen Peer aber noch in 4-MB-Bereichen nach einem Blob.
  So konnte ein Lesevorgang nicht beim Hub weitermachen, wo ein Peer bei einem
  Block abbrach, und ein Peer mit nur einigen Blöcken einer neuen Fassung
  konnte gar nicht helfen.
- Und ein Peer-Read hielt fest, was er gelesen hatte: Jeder Lesevorgang lief
  ein Rennen gegen das „ended“-Promise der Verbindung, das so lange lebt wie
  die Verbindung. Ein Knoten, der eine 400-MB-Datei empfing, hielt 447 MB an
  ArrayBuffers, bis die untätige Verbindung eine Minute später schloss. Eine
  4-GB-Datei hätte 4 GB gehalten.

## Strategie

- Peers nach Blocklisten und Blöcken fragen, nie nach Bereichen.
- In `PeerFirstBs` Block für Block lesen: jeden Block von einem Peer, der ihn
  hat, sonst vom Hub.
- Auf das Ende einer Verbindung nur hören, solange ein Lesevorgang darauf
  wartet.

## Blöcke von Peers lesen

- `PeerReads` fragt die Quellen nach `getBlobBlocks`, `getBlock` und
  `blockExists`; `getBlob`, `blobSource` und `PeerBlobSource` sind weg.
  `blobTimeoutMs` begrenzt einen Block.
- `PeerFirstBs` baut `getBlob`, Bereiche und `getBlobStream` aus den
  Blockaufrufen. Ein Stream macht beim Hub weiter, wo ein Peer abbrach, und
  nur die Blöcke, die dem Leser fehlen, werden überhaupt angefragt.
- `PeerReadServer` liefert die Blockaufrufe, zählt sie in `blobReads` und
  lehnt `setBlock` und `setBlobBlocks` ab wie jedes andere Schreiben.

## Ein Lesevorgang behält nichts

- Eine Verbindung bietet kein Promise mehr für ein Rennen, sondern
  `onEnd(listener)`. Das liefert zurück, wie man das Zuhören beendet, und ruft
  einen Listener, der nach dem Ende kommt, sofort auf.
- `_untilEnded` hört zu, solange der Lesevorgang offen ist, und hört auf,
  sobald er erledigt ist.
- Ein Test liest drei Blöcke über eine Verbindung, die offen bleibt, räumt
  den Speicher auf und prüft mit `WeakRef`s, dass keiner mehr gehalten wird.
  Mit dem alten Rennen schlägt er fehl, mit dem Listener besteht er.

## Aktualisierte Abhängigkeiten

- `@rljson/bs` mit Blöcken: `BsPeer`, `BsServer`, `BsPeerBridge` und
  `BsMulti` übertragen einen Block pro Nachricht; `readBlocks` und
  `streamBlocks` setzen Blobs zusammen. Streams fragen bis zu vier Blöcke im
  Voraus an.

## Ergebnis

- Der Hub reicht Blöcke weiter; keine Nachricht trägt mehr als einen Block
  eines Blobs, und der Hub behält die Blöcke, die er weiterreicht.
- Ein Knoten, der eine 400-MB-Datei empfängt, bleibt bei 144 MB, wo er
  vorher 717 MB erreichte.
- 794 Tests, 100 % Abdeckung.

## Offene Punkte

- Beide Enden einer Verbindung brauchen diese Version: Ein älterer Peer fragt
  weder nach Blöcken noch beantwortet er solche Fragen.
