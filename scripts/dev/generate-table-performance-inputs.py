#!/usr/bin/env python3
"""Generate deterministic A/B read fixtures in /tmp; never access a vault.

Six-type values mirror src-tauri/src/table/performance.rs::content/value.
File/creation identities differ per dataset. Full schema validation is performed
separately with the current project parseTableFile, then by Rust on real read.
"""
import hashlib
import json
from pathlib import Path

OUTPUT = Path('/tmp/shard-table-performance-inputs')
STAMP = '2026-09-01T00:00:00.000Z'
KINDS = ['text', 'number', 'date', 'select', 'multiSelect', 'checkbox']


def stable_id(prefix, key):
    return f'{prefix}_' + hashlib.sha256(f'{prefix}-{key}'.encode()).hexdigest()[:32]


def canonical(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + '\n').encode()


def make_content(rows, columns):
    field_order = [stable_id('fld', column) for column in range(columns)]
    fields = {}
    for column, field_id in enumerate(field_order):
        kind = KINDS[column % 6]
        field = {'id': field_id, 'name': f'字段 {column + 1}', 'type': kind}
        if kind in ['select', 'multiSelect']:
            field['options'] = [{'id': stable_id('opt', column * 4 + option), 'label': f'选项 {option}', 'color': 'blue'} for option in range(4)]
        fields[field_id] = field
    record_order, records = [], {}
    for row in range(rows):
        record_id = stable_id('rec', row)
        values = {}
        for column, field_id in enumerate(field_order):
            kind = fields[field_id]['type']
            if (row + column) % 17 == 0:
                value = None
            elif kind == 'text':
                value = '' if row % 29 == 0 else (f'记录 {row} / {column} / 0 ' + '长文本合成样本' * 80 if row % 100 == 0 else f'记录 {row} · 合成中文 {column} · 0')
            elif kind == 'number':
                value = ((row * 37 + column * 13) % 100003) / 10.0
            elif kind == 'date':
                value = f'2026-09-{(row + column) % 28 + 1:02d}'
            elif kind == 'checkbox':
                value = (row + column) % 2 == 0
            elif kind == 'select':
                value = fields[field_id]['options'][row % 4]['id']
            else:
                value = [fields[field_id]['options'][row % 4]['id'], fields[field_id]['options'][(row + 1) % 4]['id']]
            values[field_id] = value
        records[record_id] = {'id': record_id, 'createdAt': STAMP, 'updatedAt': STAMP, 'values': values}
        record_order.append(record_id)
    view_id = stable_id('view', 0)
    return {'primaryFieldId': field_order[0], 'fields': fields, 'fieldOrder': field_order,
            'records': records, 'recordOrder': record_order, 'viewOrder': [view_id],
            'views': {view_id: {'id': view_id, 'name': '默认视图', 'type': 'table', 'filters': {'operator': 'and', 'conditions': []},
                               'sorts': [], 'groupBy': None, 'fieldOrder': field_order.copy(), 'hiddenFieldIds': [], 'columnWidths': {}}}}


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    result = {'scope': 'Generated read-only benchmark input files only; no vault is accessed. Deterministic six-type model, version 1, stable IDs/timestamps. Initial revision 1, no mutations.', 'datasets': []}
    for label, rows, columns in [('A', 1000, 20), ('B', 10000, 30)]:
        content = make_content(rows, columns)
        table_id, request_id = stable_id('tbl', f'performance-{label}'), stable_id('req', f'performance-{label}')
        request = {'tableId': table_id, 'requestId': request_id, 'parentPath': 'notes', 'suggestedName': f'performance-{label}', 'content': content}
        file = {**content, 'kind': 'shard.table', 'schemaVersion': 1, 'id': table_id, 'revision': 1,
                'createdAt': STAMP, 'updatedAt': STAMP, 'lastMutationId': None, 'lastMutationHash': None,
                'creation': {'requestId': request_id, 'payloadHash': hashlib.sha256(canonical(request)).hexdigest()}}
        data = canonical(file)
        path = OUTPUT / f'performance-{label}.shardtable.json'
        path.write_bytes(data)
        result['datasets'].append({'label': label, 'path': str(path), 'rows': rows, 'columns': columns, 'cells': rows * columns,
                                   'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'tableId': table_id, 'schemaVersion': 1,
                                   'fixture': 'Six field types, Chinese, null every 17 cells, empty text, >560-character text every 100 rows, two-of-four multi-select options'})
    (OUTPUT / 'manifest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
