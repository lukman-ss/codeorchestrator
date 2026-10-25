import { randomUUID } from 'node:crypto';

export class RequirementExtractor {
  static extract(prompt) {
    if (!prompt || typeof prompt !== 'string') return [];

    const requirements = [];
    const lines = prompt.split(/\r?\n/);
    let currentReq = null;
    let inCodeBlock = false;
    let sectionRef = 'General';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        if (currentReq) {
          currentReq.acceptance_criteria.push(line);
        }
        continue;
      }

      if (inCodeBlock) {
        if (currentReq) {
          currentReq.acceptance_criteria.push(line);
        }
        continue;
      }

      const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
      if (headingMatch) {
        sectionRef = headingMatch[1].trim();
        continue;
      }

      const numberedMatch = line.match(/^(\d+)[\.\)]\s+(.+)$/);
      const bulletMatch = line.match(/^[-*+]\s+(.+)$/);

      if (numberedMatch || bulletMatch) {
        const text = (numberedMatch ? numberedMatch[2] : bulletMatch[1]).trim();
        if (text.length > 5) {
          const reqId = `REQ-${(requirements.length + 1).toString().padStart(3, '0')}`;
          const dependsMatch = text.match(/depends\s+on\s+(REQ-\d+)/i);
          const dependsOn = dependsMatch ? [dependsMatch[1].toUpperCase()] : [];
          const forceFailMatch = text.toLowerCase().includes('force fail');
          currentReq = {
            requirement_id: reqId,
            requirement_text: text,
            section_reference: sectionRef,
            acceptance_criteria: [text],
            mandatory: !text.toLowerCase().includes('optional') && !text.toLowerCase().includes('nice to have'),
            source_location: `line ${i + 1}`,
            verification_status: 'unverified',
            depends_on: dependsOn,
            force_fail: forceFailMatch
          };
          requirements.push(currentReq);
          continue;
        }
      }

      const explicitCritMatch = line.match(/(?:acceptance\s+criteria|verify|must|ensure|contract):\s*(.+)/i);
      if (explicitCritMatch && currentReq) {
        currentReq.acceptance_criteria.push(explicitCritMatch[1].trim());
        continue;
      }

      if (currentReq && line.trim().length > 0 && !line.startsWith('#')) {
        currentReq.acceptance_criteria.push(line.trim());
      }
    }

    if (requirements.length === 0 && prompt.trim().length > 0) {
      requirements.push({
        requirement_id: 'REQ-001',
        requirement_text: prompt.trim(),
        section_reference: 'General',
        acceptance_criteria: [prompt.trim()],
        mandatory: true,
        source_location: 'full prompt',
        verification_status: 'unverified'
      });
    }

    return requirements;
  }
}