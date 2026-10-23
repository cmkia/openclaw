#!/usr/bin/env python3
"""Project one real library book into the native wiki through its supported CLI."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.parse
import urllib.request
import uuid


def command(args, *, data=None):
    result = subprocess.run(args, input=data, text=True, encoding='utf-8', capture_output=True)
    if result.returncode:
        raise RuntimeError('Command failed: ' + ' '.join(args[:2]) + '\n' + result.stderr[-1200:])
    return result.stdout


def parse_json(output):
    value = output.strip()
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        for offset, character in enumerate(value):
            if character in '{[':
                try:
                    parsed, _ = json.JSONDecoder().raw_decode(value[offset:])
                    return parsed
                except json.JSONDecodeError:
                    pass
    raise RuntimeError('The native owner did not return JSON')


def private_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(content, encoding='utf-8')
    path.chmod(0o600)


class Projection:
    def __init__(self, args):
        self.args = args
        self.directory = args.root / args.tenant / 'library'
        self.artifacts = self.directory / ('wiki-projection-' + args.document_id)
        self.artifacts.mkdir(mode=0o700, exist_ok=True)
        self.key = (self.directory / 'api-key.secret').read_text().strip()
        containers = [json.loads(line) for line in command(['docker', 'ps', '--format', 'json']).splitlines()]
        prefix = 'openclaw-' + args.tenant
        self.gateway = next(c['Names'] for c in containers if c['Names'].startswith(prefix + '_gateway.'))
        api = next(c['Names'] for c in containers if c['Names'].startswith(prefix + '_library-api.'))
        info = parse_json(command(['docker', 'inspect', api]))[0]
        network = parse_json(command(['docker', 'network', 'inspect', 'docker_gwbridge']))[0]
        address = network['Containers'][info['Id']]['IPv4Address'].split('/')[0]
        self.base = 'http://' + address + ':8080'
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.helper = args.cli_helper or Path(__file__).resolve().parents[2] / 'clients' / 'cli.sh'
        if not self.helper.is_file() or self.helper.suffix != '.sh':
            raise RuntimeError('Provide the canonical deploy/clients/cli.sh with --cli-helper')

    def cli(self, *args):
        return parse_json(command(['sh', str(self.helper), self.args.tenant, *args]))

    def wiki(self, *args):
        return self.cli('wiki', '--agent', self.args.agent, *args, '--json')

    def get(self, path):
        request = urllib.request.Request(self.base + path, headers={'Authorization': 'Bearer ' + self.key})
        with self.opener.open(request, timeout=120) as result:
            return json.load(result)

    def original_digest(self, document_id):
        request = urllib.request.Request(self.base + '/v1/documents/' + document_id + '/original',
                                         headers={'Authorization': 'Bearer ' + self.key})
        digest = hashlib.sha256()
        total = 0
        with self.opener.open(request, timeout=120) as result:
            while chunk := result.read(1024 * 1024):
                total += len(chunk)
                digest.update(chunk)
        return digest.hexdigest(), total

    def collect(self):
        document_id = self.args.document_id
        document = next((d for d in self.get('/v1/documents')['documents'] if d['id'] == document_id), None)
        if document is None or document['status'] not in ('ready', 'pending_review'):
            raise RuntimeError('The selected real book is not available for projection')
        if 'synthetic' in document['title'].lower() or 'verification' in document['title'].lower():
            raise RuntimeError('Do not publish verification fixtures into the study wiki')
        chapters = self.get('/v1/chapters/' + document_id)['chapters']
        for chapter in chapters:
            encoded = urllib.parse.urlencode({'chapter': chapter['chapter']})
            chapter['coverage'] = self.get('/v1/coverage/' + document_id + '?' + encoded)
        digest, count = self.original_digest(document_id)
        if count != document['byte_size']:
            raise RuntimeError('Original bytes differ from the library owner record')
        provenance = {'sha256': digest, 'bytes': count, 'drive_version': None, 'drive_version_observed_at': None}
        if self.args.provenance_file:
            source = json.loads(self.args.provenance_file.read_text())['source']
            if source['document_id'] != document_id or source['sha256'] != digest or source['byte_size'] != count:
                raise RuntimeError('The prior provenance observation does not match this original')
            provenance.update(drive_version=source['version'],
                              drive_version_observed_at=datetime.datetime.fromtimestamp(
                                  self.args.provenance_file.stat().st_mtime, datetime.timezone.utc).isoformat())
        return {'document': document, 'chapters': chapters, 'provenance': provenance}

    def fingerprint(self, snapshot):
        return hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def book_title(self, snapshot):
        title = Path(snapshot['document']['title']).stem
        return title + ' · ' + self.args.document_id[:8]

    def pending(self, snapshot):
        document = snapshot['document']
        extraction = document.get('extraction') or {}
        missing = sorted(set(range(1, document['page_count'] + 1)) - set(extraction.get('indexed_pages', [])))
        return missing

    def provenance_lines(self, snapshot):
        document = snapshot['document']
        provenance = snapshot['provenance']
        lines = ['- Documento RAG: `' + document['id'] + '`.',
                 '- SHA-256 do original, conferido pela API privada: `' + provenance['sha256'] + '`.',
                 '- Original: ' + str(provenance['bytes']) + ' bytes.',
                 '- Estado do livro no RAG: `' + document['status'] + '`.',
                 '- A numeração de páginas abaixo é física; a numeração impressa não foi verificada.']
        if provenance['drive_version'] is not None:
            lines += ['- Versão Drive registrada: `' + str(provenance['drive_version']) + '`; observação operacional de ' +
                      provenance['drive_version_observed_at'] + '. Este registro não verifica mudanças posteriores no Drive.']
        else:
            lines += ['- Versão Drive: não verificada nesta projeção.']
        return lines

    def chapter_body(self, snapshot, chapter, source_path=None):
        name = chapter['chapter']
        body = ['Mapa de leitura extraído do PDF. **Revisão de cobertura pendente; numeração física.**', '',
                '- Capítulo registrado no RAG: `' + name + '`.',
                '- Páginas físicas: ' + str(chapter['page_start']) + '–' + str(chapter['page_end']) + '.',
                '- Trechos: ' + str(chapter['chunk_count']) + '; seções: ' + str(chapter['sections']) + '.', '']
        if name == 'Unassigned chapter':
            body += ['Este é o grupo de material sem capítulo identificado pelo extrator. Não é um capítulo zero.', '']
        if chapter is snapshot['chapters'][-1]:
            body += ['O último grupo pode incluir material final do livro. Confira seu limite antes de preparar uma aula.', '']
        missing = [p for p in self.pending(snapshot) if chapter['page_start'] <= p <= chapter['page_end']]
        if missing:
            body += ['Páginas deste intervalo sem texto indexado: ' + ', '.join(map(str, missing)) +
                     '. Confira no original se são páginas em branco, imagens ou falhas de extração; a causa não foi determinada.', '']
        body += ['## Seções extraídas', '']
        for section in chapter['coverage']['sections']:
            body += ['- ' + section['section'].replace('\n', ' ') + ': páginas ' + str(section['page_start']) +
                     '–' + str(section['page_end']) + '; ' + str(section['chunk_count']) + ' trechos.']
        body += ['', '## Como estudar', '',
                 'Peça ao assistente para ler o capítulo completo e abrir as páginas do original. '
                 'Confira figuras, tabelas, números e referências antes de preparar o fichamento.']
        if source_path:
            body += ['', 'Fonte do mapa: [[' + source_path + '|Estrutura e proveniência do livro]].']
        return '\n'.join(body) + '\n'

    def summary_body(self, snapshot, links=()):
        document = snapshot['document']
        chapters = snapshot['chapters']
        body = ['Mapa estrutural do livro. **Revisão de cobertura pendente; numeração física.**', '',
                '- Livro: ' + document['title'] + '.',
                '- Páginas físicas: ' + str(document['page_count']) + '; com texto indexado: ' +
                str(len(document['extraction'].get('indexed_pages', []))) + '.',
                '- Grupos de leitura: ' + str(len(chapters)) + '; trechos: ' + str(sum(c['chunk_count'] for c in chapters)) + '.',
                '- Páginas sem texto indexado que precisam de conferência: ' + ', '.join(map(str, self.pending(snapshot))) + '.',
                '- O último capítulo pode incluir material final; seus limites precisam de revisão.', '', '## Mapas de leitura', '']
        if links:
            body += ['- [[' + page['pagePath'] + '|' + page['title'] + ']]' for page in links]
        else:
            body += ['- ' + c['chapter'] + ' — páginas ' + str(c['page_start']) + '–' + str(c['page_end']) for c in chapters]
        return '\n'.join(body + ['', '## Proveniência', ''] + self.provenance_lines(snapshot)) + '\n'

    def prepare(self):
        snapshot = self.collect()
        prefix = self.book_title(snapshot)
        targets = [{'title': prefix + ' — ' + c['chapter'], 'chapter': c['chapter']} for c in snapshot['chapters']]
        plan = {'tenant': self.args.tenant, 'agent': self.args.agent, 'document_id': self.args.document_id,
                'prepared_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'snapshot': snapshot,
                'fingerprint': self.fingerprint(snapshot), 'source_title': 'Estrutura bibliográfica — ' + prefix,
                'book_hub_title': prefix + ' — Mapa do livro', 'catalog_title': self.args.catalog_title or
                'Biblioteca de estudos — ' + self.args.tenant.title(), 'targets': targets,
                'existing_pages': 'preserve without rewriting; new pages remain review',
                'order': ['ingest source', 'chapter maps', 'book hub', 'global catalog last']}
        private_write(self.artifacts / 'plan.json', json.dumps(plan, indent=2, ensure_ascii=False) + '\n')
        private_write(self.artifacts / 'source.md', self.summary_body(snapshot) + '\n## Estrutura detalhada\n\n' +
                      '\n\n'.join(self.chapter_body(snapshot, chapter) for chapter in snapshot['chapters']))
        private_write(self.artifacts / 'sample-catalog.md', self.summary_body(snapshot))
        first = next((c for c in snapshot['chapters'] if c['chapter'] != 'Unassigned chapter'), snapshot['chapters'][0])
        private_write(self.artifacts / 'sample-chapter.md', self.chapter_body(snapshot, first))
        unassigned = next((c for c in snapshot['chapters'] if c['chapter'] == 'Unassigned chapter'), snapshot['chapters'][-1])
        private_write(self.artifacts / 'sample-unassigned.md', self.chapter_body(snapshot, unassigned))
        print(json.dumps({'prepared': str(self.artifacts), 'chapters': len(targets), 'fingerprint': plan['fingerprint'],
                          'wiki_mutations': 0, 'targets': [t['title'] for t in targets]}, ensure_ascii=False), flush=True)

    def existing(self, title):
        value = self.wiki('search', title, '--max-results', '100')
        results = value.get('results', []) if isinstance(value, dict) else value
        matches = [p for p in results if p.get('title') == title and p.get('corpus') == 'wiki']
        if len(matches) > 1:
            raise RuntimeError('Ambiguous existing wiki title: ' + title)
        return matches[0] if matches else None

    def workspace_write(self, name, content):
        path = str(Path(self.args.workspace) / 'imports' / 'library-wiki' / self.args.document_id / name)
        program = 'const fs=require("node:fs"),p=process.argv[1];fs.mkdirSync(require("node:path").dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,fs.readFileSync(0),{mode:0o600});fs.chmodSync(p,0o600)'
        command(['docker', 'exec', '--user', '1000:1000', '-i', self.gateway, 'node', '-e', program, path], data=content)
        return path

    def apply_page(self, title, body, source_id, name):
        existing = self.existing(title)
        if existing:
            if existing.get('kind') != 'synthesis':
                raise RuntimeError('Existing title is not a synthesis: ' + title)
            return {'pageId': existing['id'], 'pagePath': existing['path'], 'title': title, 'preserved': True}
        body_path = self.workspace_write(name, body)
        result = self.wiki('apply', 'synthesis', title, '--body-file', body_path, '--source-id', source_id, '--status', 'review')
        return {**result, 'title': title, 'preserved': False}

    def apply(self):
        plan = json.loads((self.artifacts / 'plan.json').read_text())
        expected = (self.args.tenant, self.args.agent, self.args.document_id)
        if (plan['tenant'], plan['agent'], plan['document_id']) != expected:
            raise RuntimeError('Prepared plan tenant, agent or document differs from this invocation')
        snapshot = self.collect()
        if plan['fingerprint'] != self.fingerprint(snapshot):
            raise RuntimeError('Library facts changed after preparation; prepare and review again')
        before = self.wiki('status')
        existing_source = self.existing(plan['source_title'])
        if existing_source:
            if existing_source.get('kind') != 'source':
                raise RuntimeError('Existing source title is not a source page')
            source = {'pageId': existing_source['id'], 'pagePath': existing_source['path'], 'preserved': True}
        else:
            source_path = self.workspace_write('structure-source.md', (self.artifacts / 'source.md').read_text())
            source = self.wiki('ingest', source_path, '--title', plan['source_title'])
        source_id = source['pageId']
        pages = []
        for index, (target, chapter) in enumerate(zip(plan['targets'], snapshot['chapters'], strict=True)):
            page = self.apply_page(target['title'], self.chapter_body(snapshot, chapter, source['pagePath']), source_id,
                                   'chapter-' + str(index).zfill(2) + '.md')
            pages.append(page)
            print('MAP ' + str(index + 1) + '/' + str(len(plan['targets'])) + ' ' + page['pageId'], flush=True)
        hub = self.apply_page(plan['book_hub_title'], self.summary_body(snapshot, pages), source_id, 'book-hub.md')
        existing = self.existing(plan['catalog_title'])
        marker = '<!-- library-book:' + self.args.document_id + ':start -->'
        end = '<!-- library-book:' + self.args.document_id + ':end -->'
        book_block = marker + '\n- [[' + hub['pagePath'] + '|' + hub['title'] + ']] — ' + snapshot['document']['status'] + '\n' + end
        intro = 'Índice de materiais e mapas de leitura. Revisão de cobertura pendente.\n\n'
        previous_blocks = []
        if existing:
            if existing.get('kind') != 'synthesis':
                raise RuntimeError('Existing catalog title is not a synthesis')
            current = self.wiki('get', existing['id'], '--lines', '10000')
            previous_blocks = re.findall(r'<!-- library-book:[^>]+:start -->[\s\S]*?<!-- library-book:[^>]+:end -->', current['content'])
            if not previous_blocks:
                raise RuntimeError('Existing catalog has no operator-managed book blocks; preserve it for human review')
            if any(block.startswith(marker) for block in previous_blocks):
                catalog = {'pageId': existing['id'], 'pagePath': existing['path'], 'preserved': True}
            else:
                # Markdown/frontmatter is the public wiki artifact contract. Only reads occur here;
                # the native mutation owner still preserves human notes and writes the page.
                read_metadata = '''const fs=require('node:fs'),path=require('node:path'),YAML=require('yaml');
const root=fs.realpathSync(process.argv[1]),file=fs.realpathSync(path.resolve(root,process.argv[2]));
if(!file.startsWith(root+path.sep))throw Error('Wiki artifact outside the owner vault');
const text=fs.readFileSync(file,'utf8'),match=text.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---(?:\\r?\\n|$)/);
if(!match)throw Error('Wiki frontmatter is missing');
const meta=YAML.parse(match[1]);console.log(JSON.stringify({status:meta.status,sourceIds:meta.sourceIds}));'''
                metadata = parse_json(command(['docker', 'exec', self.gateway, 'node', '-e', read_metadata,
                                               before['vaultPath'], existing['path']]))
                if not isinstance(metadata.get('status'), str) or not isinstance(metadata.get('sourceIds'), list):
                    raise RuntimeError('Preserve the catalog: status/sourceIds contract is not readable')
                generated = re.search(r'<!-- openclaw:wiki:generated:start -->([\s\S]*?)<!-- openclaw:wiki:generated:end -->',
                                      current['content'])
                if not generated or current.get('truncated'):
                    raise RuntimeError('Preserve the catalog: complete generated content is not available')
                body_path = self.workspace_write('catalog.md', generated[1].strip() + '\n\n' + book_block + '\n')
                arguments = ['apply', 'synthesis', plan['catalog_title'], '--body-file', body_path,
                             '--status', metadata['status']]
                for identity in dict.fromkeys([*metadata['sourceIds'], source_id]):
                    if not isinstance(identity, str):
                        raise RuntimeError('Preserve the catalog: invalid source identity')
                    arguments += ['--source-id', identity]
                catalog = self.wiki(*arguments)
        else:
            catalog = self.apply_page(plan['catalog_title'], intro + book_block + '\n', source_id, 'catalog.md')
        lint = self.wiki('lint')
        after = self.wiki('status')
        parameters = json.dumps({'agentId': self.args.agent})
        gateway_compile = self.cli('gateway', 'call', 'wiki.compile', '--params', parameters,
                                   '--json', '--timeout', '60000')
        overview = self.cli('gateway', 'call', 'wiki.overview', '--params', parameters,
                            '--json', '--timeout', '60000')
        visible = {item.get('id') for cluster in overview['clusters'] for item in cluster['items']}
        expected_ids = {page['pageId'] for page in [*pages, hub, catalog]}
        if overview['pageCounts']['synthesis'] != after['pageCounts']['synthesis']:
            raise RuntimeError('Gateway wiki projection does not match the native owner count')
        if not overview['truncated'] and not expected_ids.issubset(visible):
            raise RuntimeError('Gateway wiki projection is missing published map identities')
        report = {'source': source, 'pages': pages, 'book_hub': hub, 'catalog': catalog,
                  'before': before, 'after': after, 'lint': lint, 'fingerprint': plan['fingerprint'],
                  'gateway_compile': gateway_compile, 'gateway_overview': overview}
        private_write(self.artifacts / 'owner-results.json', json.dumps(report, indent=2, ensure_ascii=False) + '\n')
        owned_paths = {page['pagePath'] for page in [*pages, hub, catalog]}
        if any(issue['path'] in owned_paths and issue['code'] == 'broken-wikilink' for issue in lint['issues']):
            raise RuntimeError('Published maps have broken links; inspect the native owner lint report')
        print(json.dumps({'completed': True, 'source_id': source_id, 'maps': len(pages), 'book_hub': hub['pageId'],
                          'catalog': catalog['pageId'], 'page_counts': after['pageCounts'], 'lint': lint}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tenant', required=True)
    parser.add_argument('--document-id', required=True)
    parser.add_argument('--agent', default='main')
    parser.add_argument('--root', type=Path, default=Path('/opt/openclaw/clients'))
    parser.add_argument('--cli-helper', type=Path)
    parser.add_argument('--workspace', default='/home/node/.openclaw/workspace')
    parser.add_argument('--catalog-title')
    parser.add_argument('--provenance-file', type=Path)
    parser.add_argument('--apply', action='store_true', help='Apply a prepared, reviewed plan through native owners')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', args.tenant):
        parser.error('Invalid tenant slug')
    args.document_id = str(uuid.UUID(args.document_id))
    os.umask(0o077)
    projection = Projection(args)
    if args.apply:
        projection.apply()
    else:
        projection.prepare()


if __name__ == '__main__':
    main()
