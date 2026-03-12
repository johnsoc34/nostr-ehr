import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { patientId, status, name, email, monthlyFee, is_test_patient, patientType } = body;
    const db = await getDb();
    const updates = [];
    const values = [];
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }
    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (email !== undefined) {
      updates.push('email = ?');
      values.push(email);
    }
    if (monthlyFee !== undefined) {
      updates.push('monthly_fee = ?');
      values.push(monthlyFee);
    }
    if (is_test_patient !== undefined) {
      updates.push('is_test_patient = ?');
      values.push(is_test_patient ? 1 : 0);
    }
    if (patientType !== undefined) {
      updates.push('patient_type = ?');
      values.push(patientType);
    }
    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }
    values.push(patientId);
    await db.run(
      `UPDATE patients SET ${updates.join(', ')} WHERE id = ?`,
      values
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating patient:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
