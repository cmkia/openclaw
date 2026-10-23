"""Inspect PPTX package structure. Does not claim native PowerPoint or clinical validation."""
import argparse
import json
import math
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'


def validate(pptx, geometry=None, expected_slides=None):
    findings = []
    counts = {'slides': 0, 'notes': 0, 'charts': 0, 'media': 0, 'tables': 0}
    if Path(pptx).stat().st_size > 200 * 1024 * 1024:
        raise ValueError('PPTX file exceeds 200 MiB')
    with zipfile.ZipFile(pptx) as package:
        names = package.namelist()
        if len(names) != len(set(names)):
            findings.append('Duplicate ZIP entries')
        if len(names) > 10000 or sum(item.file_size for item in package.infolist()) > 512 * 1024 * 1024:
            raise ValueError('PPTX package exceeds inspection limits')
        parts = set(names)
        xml = {}
        for name in names:
            if name.startswith('/') or '..' in name.split('/'):
                findings.append('Unsafe package part path')
                continue
            if name.endswith(('.xml', '.rels')):
                data = package.read(name)
                if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
                    raise ValueError('XML entities are not supported')
                xml[name] = ET.fromstring(data)
        for required in ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml']:
            if required not in xml:
                findings.append(f'Missing package part: {required}')
        rels = {}
        for name, root in xml.items():
            if not name.endswith('.rels'):
                continue
            owner = '' if name == '_rels/.rels' else posixpath.join(posixpath.dirname(posixpath.dirname(name)), posixpath.basename(name)[:-5])
            mapping = {}
            for rel in root.findall(f'{{{REL_NS}}}Relationship'):
                rid, target = rel.get('Id'), rel.get('Target', '')
                if not rid or rid in mapping:
                    findings.append(f'Invalid relationship ID in {name}')
                if rel.get('TargetMode') == 'External':
                    if not rel.get('Type', '').endswith('/hyperlink'):
                        findings.append(f'External non-hyperlink resource in {name}')
                    mapping[rid] = None
                    continue
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(owner), target)) if not target.startswith('/') else target[1:]
                if resolved not in parts:
                    findings.append(f'Missing relationship target in {name}: {resolved}')
                mapping[rid] = resolved
            rels[owner] = mapping
        slides = [name for name in xml if re.fullmatch(r'ppt/slides/slide\d+\.xml', name)]
        counts['slides'] = len(slides)
        counts['notes'] = len([name for name in xml if re.fullmatch(r'ppt/notesSlides/notesSlide\d+\.xml', name)])
        counts['charts'] = len([name for name in xml if re.fullmatch(r'ppt/(?:slides/)?charts/chart\d+\.xml', name)])
        counts['media'] = len([name for name in names if name.startswith('ppt/media/') and not name.endswith('/')])
        if not 1 <= counts['slides'] <= 50:
            findings.append('Slide count must be between 1 and 50')
        if expected_slides is not None and counts['slides'] != expected_slides:
            findings.append('Slide count differs from manifest')
        if counts['notes'] != counts['slides']:
            findings.append('Notes count differs from slide count')
        presentation = xml.get('ppt/presentation.xml')
        if presentation is not None:
            listed = presentation.findall(f'{{{P}}}sldIdLst/{{{P}}}sldId')
            if len(listed) != counts['slides']:
                findings.append('Presentation slide list differs from package slide count')
            targets = [rels.get('ppt/presentation.xml', {}).get(item.get(f'{{{OFFICE_REL_NS}}}id')) for item in listed]
            if len(set(targets)) != len(slides) or set(targets) != set(slides):
                findings.append('Presentation must reference each slide exactly once')
        for name, root in xml.items():
            if not name.endswith('.xml'):
                continue
            for element in root.iter():
                for attribute, value in element.attrib.items():
                    if attribute.startswith(f'{{{OFFICE_REL_NS}}}') and value not in rels.get(name, {}):
                        findings.append(f'Unresolved relationship reference in {name}')
                    if value.strip().lower() in {'nan', 'infinity', '-infinity', 'inf', '-inf'}:
                        findings.append(f'Non-finite XML numeric attribute in {name}')
            for cell in root.findall(f'.//{{{A}}}tcPr'):
                if cell.get('anchor') not in {None, 't', 'ctr', 'b', 'just', 'dist'}:
                    findings.append(f'Invalid table vertical alignment in {name}: {cell.get("anchor")}')
            for value in root.findall(f'.//{{{C}}}numCache/{{{C}}}pt/{{{C}}}v') + root.findall(f'.//{{{C}}}numLit/{{{C}}}pt/{{{C}}}v'):
                try:
                    valid = math.isfinite(float(value.text))
                except (TypeError, ValueError):
                    valid = False
                if not valid:
                    findings.append(f'Invalid chart numeric value in {name}')
        for name in slides:
            counts['tables'] += len(xml[name].findall(f'.//{{{A}}}tbl'))
            notes = [target for target in rels.get(name, {}).values() if target and target.startswith('ppt/notesSlides/')]
            if len(notes) != 1:
                findings.append(f'Slide needs exactly one notes relationship: {name}')
        if geometry is not None:
            report = json.loads(Path(geometry).read_text(encoding='utf-8'))
            width, height = report['slideWidth'], report['slideHeight']
            if not all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0 for v in [width, height]):
                findings.append('Invalid geometry canvas')
            for item in report['objects']:
                values = [item.get(key) for key in ['x', 'y', 'w', 'h']]
                if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
                    findings.append('Invalid object numeric geometry')
                    continue
                x, y, w, h = values
                if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > width + .001 or y + h > height + .001:
                    findings.append(f'Object outside slide bounds: slide{item.get("slide")}')
    return {'status': 'pass' if not findings else 'fail', 'counts': counts, 'findings': findings,
            'claimBoundary': 'OOXML package and supplied renderer geometry only. Text-fit estimates, source accuracy, clinical validity, visual review, and native PowerPoint behavior are separate checks.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pptx')
    parser.add_argument('--geometry')
    parser.add_argument('--expected-slides', type=int)
    args = parser.parse_args()
    try:
        result = validate(args.pptx, args.geometry, args.expected_slides)
    except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile, ET.ParseError) as error:
        result = {'status': 'fail', 'findings': [f'{type(error).__name__}: {error}'], 'claimBoundary': 'Package inspection failed; no native PowerPoint claim.'}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['status'] == 'pass' else 1


if __name__ == '__main__':
    sys.exit(main())
