import {
  Peserta,
  Penguji,
  Kelompok,
  PenilaianPeserta,
  AppSettings,
  AuthUser,
} from '../types';

export const GOOGLE_DRIVE_FOLDER_ID = '1rxfTvUjeKbqYR8qB5nZYflihb2f_ezxD';
export const GOOGLE_DRIVE_FOLDER_URL =
  'https://drive.google.com/drive/folders/1rxfTvUjeKbqYR8qB5nZYflihb2f_ezxD?usp=sharing';
export const MASTER_SYNC_FILENAME = 'pramuka_garuda_master_sync.json';

export interface SyncPayload {
  version: number;
  appName: string;
  lastSyncedAt: string;
  syncedBy: {
    role: 'admin' | 'penguji';
    username: string;
    displayName: string;
    googleEmail?: string;
  };
  peserta: Peserta[];
  penguji: Penguji[];
  kelompok: Kelompok[];
  penilaian: Record<string, PenilaianPeserta>;
  settings?: AppSettings;
  meta?: {
    isFullAdminSync?: boolean;
    note?: string;
  };
}

export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  description?: string;
  webViewLink?: string;
}

export interface SyncMergeReport {
  timestamp: string;
  mode: 'merge_and_update' | 'admin_deletion_sync';
  peserta: {
    added: number;
    updated: number;
    total: number;
  };
  penguji: {
    added: number;
    updated: number;
    total: number;
  };
  kelompok: {
    added: number;
    updated: number;
    total: number;
  };
  penilaian: {
    added: number;
    updated: number;
    total: number;
  };
  remoteLastUpdated?: string;
  remoteUpdatedBy?: string;
}

/**
 * Check if the user has access to the target Google Drive folder
 */
export async function verifyFolderAccess(accessToken: string): Promise<{
  accessible: boolean;
  name?: string;
  error?: string;
}> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${GOOGLE_DRIVE_FOLDER_ID}?fields=id,name,capabilities,webViewLink`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (res.status === 404) {
      return {
        accessible: false,
        error:
          'Folder Google Drive tidak ditemukan atau belum dibagikan ke akun Google Anda.',
      };
    }

    if (res.status === 403) {
      return {
        accessible: false,
        error:
          'Akses ditolak ke folder Google Drive. Pastikan akun Google Anda telah diberikan izin akses.',
      };
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return {
        accessible: false,
        error: err.error?.message || `Gagal mengakses folder (Status: ${res.status})`,
      };
    }

    const data = await res.json();
    return {
      accessible: true,
      name: data.name || 'Folder Penilaian Pramuka Garuda',
    };
  } catch (e: any) {
    return {
      accessible: false,
      error: e.message || 'Koneksi jaringan ke Google Drive terputus.',
    };
  }
}

/**
 * List files in the target folder
 */
export async function listFolderFiles(
  accessToken: string
): Promise<DriveFileInfo[]> {
  const query = encodeURIComponent(
    `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`
  );
  const fields = encodeURIComponent(
    'files(id, name, mimeType, modifiedTime, size, description, webViewLink)'
  );
  const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&orderBy=modifiedTime desc&pageSize=50`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err.error?.message || `Gagal membaca isi folder Google Drive (${res.status})`
    );
  }

  const data = await res.json();
  return data.files || [];
}

/**
 * Find the primary master sync file in the folder
 */
export async function findMasterSyncFile(
  accessToken: string
): Promise<DriveFileInfo | null> {
  const files = await listFolderFiles(accessToken);
  const master = files.find((f) => f.name === MASTER_SYNC_FILENAME);
  return master || null;
}

/**
 * Download and parse a JSON file from Drive
 */
export async function downloadJsonFile<T = any>(
  accessToken: string,
  fileId: string
): Promise<T> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!res.ok) {
    throw new Error(`Gagal mengunduh file dari Google Drive (${res.status})`);
  }

  return await res.json();
}

/**
 * Upload a new file to the Google Drive folder via multipart upload
 */
export async function uploadJsonToDrive(
  accessToken: string,
  fileName: string,
  payload: any,
  description?: string
): Promise<DriveFileInfo> {
  const metadata = {
    name: fileName,
    mimeType: 'application/json',
    parents: [GOOGLE_DRIVE_FOLDER_ID],
    description: description || 'Data Sinkronisasi Pramuka Garuda Banyumas',
  };

  const fileContent = JSON.stringify(payload, null, 2);
  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;

  const multipartRequestBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: application/json\r\n\r\n' +
    fileContent +
    closeDelim;

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,description,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartRequestBody,
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err.error?.message || `Gagal mengunggah data ke Google Drive (${res.status})`
    );
  }

  return await res.json();
}

/**
 * Update an existing JSON file in Google Drive
 */
export async function updateJsonInDrive(
  accessToken: string,
  fileId: string,
  payload: any,
  description?: string
): Promise<DriveFileInfo> {
  const fileContent = JSON.stringify(payload, null, 2);

  // Update content
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: fileContent,
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err.error?.message || `Gagal memperbarui file di Google Drive (${res.status})`
    );
  }

  // Update description/metadata if provided
  if (description) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ description }),
    }).catch(() => {});
  }

  return await res.json();
}

/**
 * Delete a file in Google Drive (Destructive: requires user confirmation per policy)
 */
export async function deleteDriveFile(
  accessToken: string,
  fileId: string
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err.error?.message || `Gagal menghapus file dari Google Drive (${res.status})`
    );
  }
}

// ========================================================
// SMART MERGE & UPDATE LOGIC (Tidak menghapus data lama)
// ========================================================

function normalizeKey(str: string): string {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Performs a two-way Merge and Update between local data and remote cloud data.
 * Guarantees no existing participants, examiners, teams, or grades are deleted.
 * Newer or more detailed fields overwrite older blanks.
 */
export function mergeAndUpdateAppData(
  local: {
    peserta: Peserta[];
    penguji: Penguji[];
    kelompok: Kelompok[];
    penilaian: Record<string, PenilaianPeserta>;
    settings: AppSettings;
  },
  remote: SyncPayload | null,
  currentUser: AuthUser,
  googleEmail?: string
): {
  merged: SyncPayload;
  report: SyncMergeReport;
} {
  let pesertaAdded = 0;
  let pesertaUpdated = 0;
  let pengujiAdded = 0;
  let pengujiUpdated = 0;
  let kelompokAdded = 0;
  let kelompokUpdated = 0;
  let penilaianAdded = 0;
  let penilaianUpdated = 0;

  if (!remote) {
    // No remote data yet: return local packaged as new master payload
    const initialPayload: SyncPayload = {
      version: 1,
      appName: 'Penilaian Pramuka Garuda Kemranjen-Siaga',
      lastSyncedAt: new Date().toISOString(),
      syncedBy: {
        role: currentUser.role,
        username: currentUser.username,
        displayName: currentUser.displayName,
        googleEmail,
      },
      peserta: local.peserta,
      penguji: local.penguji,
      kelompok: local.kelompok,
      penilaian: local.penilaian,
      settings: local.settings,
      meta: {
        note: 'Sinkronisasi awal ke Google Drive',
      },
    };

    return {
      merged: initialPayload,
      report: {
        timestamp: new Date().toISOString(),
        mode: 'merge_and_update',
        peserta: { added: 0, updated: 0, total: local.peserta.length },
        penguji: { added: 0, updated: 0, total: local.penguji.length },
        kelompok: { added: 0, updated: 0, total: local.kelompok.length },
        penilaian: {
          added: 0,
          updated: 0,
          total: Object.keys(local.penilaian).length,
        },
      },
    };
  }

  // --- 1. PESERTA MERGE ---
  const mergedPesertaMap = new Map<string, Peserta>();

  // Helper key to identify duplicate peserta across sources
  const getPesertaKey = (p: Peserta) => {
    const no = normalizeKey(p.nomorPeserta);
    if (no) return `no:${no}`;
    const name = normalizeKey(p.nama);
    const pang = normalizeKey(p.pangkalan);
    return `name:${name}_${pang}`;
  };

  // Add all remote first
  (remote.peserta || []).forEach((remP) => {
    mergedPesertaMap.set(getPesertaKey(remP), remP);
  });

  // Merge or add local
  local.peserta.forEach((locP) => {
    const key = getPesertaKey(locP);
    if (mergedPesertaMap.has(key)) {
      const remP = mergedPesertaMap.get(key)!;
      // Merge properties: choose richer/latest data
      const merged: Peserta = {
        id: locP.id || remP.id,
        nomorPeserta: locP.nomorPeserta || remP.nomorPeserta,
        nama: locP.nama.length >= remP.nama.length ? locP.nama : remP.nama,
        jenisKelamin: locP.jenisKelamin || remP.jenisKelamin,
        pangkalan: locP.pangkalan || remP.pangkalan,
        gudep: locP.gudep || remP.gudep,
        kelompokId: locP.kelompokId || remP.kelompokId,
        golongan: locP.golongan || remP.golongan,
        tingkatTKU: locP.tingkatTKU || remP.tingkatTKU,
        kontakHp: locP.kontakHp || remP.kontakHp,
        namaPembina: locP.namaPembina || remP.namaPembina,
      };
      mergedPesertaMap.set(key, merged);
      pesertaUpdated++;
    } else {
      mergedPesertaMap.set(key, locP);
      pesertaAdded++;
    }
  });

  const mergedPeserta = Array.from(mergedPesertaMap.values());

  // --- 2. PENGUJI MERGE ---
  const mergedPengujiMap = new Map<string, Penguji>();
  const getPengujiKey = (pj: Penguji) => {
    const nip = normalizeKey(pj.nipNta || '');
    if (nip) return `nip:${nip}`;
    return `nama:${normalizeKey(pj.nama)}`;
  };

  (remote.penguji || []).forEach((remPj) => {
    mergedPengujiMap.set(getPengujiKey(remPj), remPj);
  });

  local.penguji.forEach((locPj) => {
    const key = getPengujiKey(locPj);
    if (mergedPengujiMap.has(key)) {
      const remPj = mergedPengujiMap.get(key)!;
      mergedPengujiMap.set(key, {
        id: locPj.id || remPj.id,
        nama: locPj.nama || remPj.nama,
        nipNta: locPj.nipNta || remPj.nipNta,
        jabatan: locPj.jabatan || remPj.jabatan,
        pangkalan: locPj.pangkalan || remPj.pangkalan,
        noHp: locPj.noHp || remPj.noHp,
      });
      pengujiUpdated++;
    } else {
      mergedPengujiMap.set(key, locPj);
      pengujiAdded++;
    }
  });

  const mergedPenguji = Array.from(mergedPengujiMap.values());

  // --- 3. KELOMPOK MERGE ---
  const mergedKelompokMap = new Map<string, Kelompok>();
  const getKelompokKey = (k: Kelompok) => normalizeKey(k.nama);

  (remote.kelompok || []).forEach((remK) => {
    mergedKelompokMap.set(getKelompokKey(remK), remK);
  });

  local.kelompok.forEach((locK) => {
    const key = getKelompokKey(locK);
    if (mergedKelompokMap.has(key)) {
      const remK = mergedKelompokMap.get(key)!;
      // Merge lists
      const mergedPengujiIds = Array.from(
        new Set([...(locK.pengujiIds || []), ...(remK.pengujiIds || [])])
      );
      const mergedPesertaIds = Array.from(
        new Set([...(locK.pesertaIds || []), ...(remK.pesertaIds || [])])
      );

      mergedKelompokMap.set(key, {
        id: locK.id || remK.id,
        nama: locK.nama || remK.nama,
        jenisKelamin: locK.jenisKelamin || remK.jenisKelamin,
        pangkalan: locK.pangkalan || remK.pangkalan,
        pemimpinRegu: locK.pemimpinRegu || remK.pemimpinRegu,
        pembinaPendamping: locK.pembinaPendamping || remK.pembinaPendamping,
        namaPenguji: locK.namaPenguji || remK.namaPenguji,
        pengujiIds: mergedPengujiIds,
        pesertaIds: mergedPesertaIds,
        keterangan: locK.keterangan || remK.keterangan,
      });
      kelompokUpdated++;
    } else {
      mergedKelompokMap.set(key, locK);
      kelompokAdded++;
    }
  });

  const mergedKelompok = Array.from(mergedKelompokMap.values());

  // --- 4. PENILAIAN MERGE ---
  // Penilaian is keyed by pesertaId. But we also cross-map by nomorPeserta to ensure matching
  const mergedPenilaian: Record<string, PenilaianPeserta> = {};
  const remotePenilaian = remote.penilaian || {};
  const localPenilaian = local.penilaian || {};

  // Build mapping from remote peserta id to matched merged peserta id
  const pesertaIdMap = new Map<string, string>(); // oldId -> canonicalId
  (remote.peserta || []).forEach((remP) => {
    const key = getPesertaKey(remP);
    const matched = mergedPesertaMap.get(key);
    if (matched) {
      pesertaIdMap.set(remP.id, matched.id);
    }
  });
  local.peserta.forEach((locP) => {
    const key = getPesertaKey(locP);
    const matched = mergedPesertaMap.get(key);
    if (matched) {
      pesertaIdMap.set(locP.id, matched.id);
    }
  });

  // Calculate score helper
  const calculateTotalScore = (pen?: PenilaianPeserta) => {
    if (!pen) return -1;
    const adminCount = (pen.administrasi || []).filter((a) => a.tersedia).length;
    const wawancaraScore = (pen.wawancara || []).reduce(
      (sum, w) => sum + (w.poin || 0),
      0
    );
    return adminCount + wawancaraScore;
  };

  // Process all canonical peserta IDs
  mergedPeserta.forEach((p) => {
    const canonicalId = p.id;

    // Find in local
    let locPen = localPenilaian[canonicalId];
    if (!locPen) {
      // Try finding by original local participant id
      const originalLocal = local.peserta.find(
        (lp) => getPesertaKey(lp) === getPesertaKey(p)
      );
      if (originalLocal) locPen = localPenilaian[originalLocal.id];
    }

    // Find in remote
    let remPen: PenilaianPeserta | undefined = undefined;
    for (const [rId, rVal] of Object.entries(remotePenilaian)) {
      if (rId === canonicalId || pesertaIdMap.get(rId) === canonicalId) {
        remPen = rVal;
        break;
      }
    }

    if (locPen && !remPen) {
      mergedPenilaian[canonicalId] = { ...locPen, pesertaId: canonicalId };
      penilaianAdded++;
    } else if (!locPen && remPen) {
      mergedPenilaian[canonicalId] = { ...remPen, pesertaId: canonicalId };
      penilaianAdded++;
    } else if (locPen && remPen) {
      const locScore = calculateTotalScore(locPen);
      const remScore = calculateTotalScore(remPen);
      const locTime = new Date(locPen.updatedAt || 0).getTime();
      const remTime = new Date(remPen.updatedAt || 0).getTime();

      // If one is filled and other is 0 / empty, prefer the filled one
      if (locScore > 0 && remScore === 0) {
        mergedPenilaian[canonicalId] = { ...locPen, pesertaId: canonicalId };
      } else if (remScore > 0 && locScore === 0) {
        mergedPenilaian[canonicalId] = { ...remPen, pesertaId: canonicalId };
      } else if (locTime >= remTime) {
        mergedPenilaian[canonicalId] = { ...locPen, pesertaId: canonicalId };
      } else {
        mergedPenilaian[canonicalId] = { ...remPen, pesertaId: canonicalId };
      }
      penilaianUpdated++;
    }
  });

  // --- 5. SETTINGS MERGE ---
  // Prefer local settings if customized, otherwise fallback to remote
  const mergedSettings: AppSettings = {
    ...remote.settings,
    ...local.settings,
    customLogoUrl: local.settings.customLogoUrl || remote.settings?.customLogoUrl,
    logoKiriUrl: local.settings.logoKiriUrl || remote.settings?.logoKiriUrl,
    logoKananUrl: local.settings.logoKananUrl || remote.settings?.logoKananUrl,
  };

  const finalPayload: SyncPayload = {
    version: (remote.version || 1) + 1,
    appName: 'Penilaian Pramuka Garuda Kemranjen-Siaga',
    lastSyncedAt: new Date().toISOString(),
    syncedBy: {
      role: currentUser.role,
      username: currentUser.username,
      displayName: currentUser.displayName,
      googleEmail,
    },
    peserta: mergedPeserta,
    penguji: mergedPenguji,
    kelompok: mergedKelompok,
    penilaian: mergedPenilaian,
    settings: mergedSettings,
    meta: {
      note: `Sinkronisasi Cerdas (Merge & Update) oleh ${currentUser.displayName}`,
    },
  };

  return {
    merged: finalPayload,
    report: {
      timestamp: finalPayload.lastSyncedAt,
      mode: 'merge_and_update',
      peserta: {
        added: pesertaAdded,
        updated: pesertaUpdated,
        total: mergedPeserta.length,
      },
      penguji: {
        added: pengujiAdded,
        updated: pengujiUpdated,
        total: mergedPenguji.length,
      },
      kelompok: {
        added: kelompokAdded,
        updated: kelompokUpdated,
        total: mergedKelompok.length,
      },
      penilaian: {
        added: penilaianAdded,
        updated: penilaianUpdated,
        total: Object.keys(mergedPenilaian).length,
      },
      remoteLastUpdated: remote.lastSyncedAt,
      remoteUpdatedBy: remote.syncedBy?.displayName,
    },
  };
}

/**
 * ADMIN DELETION SYNC (Khusus Admin)
 * Synchronizes deletions made by the admin so Google Drive matches the admin's current local state.
 * Any participant, examiner, team, or grade that was permanently removed locally by the admin
 * is also removed in the master file on Google Drive.
 */
export function buildAdminDeletionSyncPayload(
  local: {
    peserta: Peserta[];
    penguji: Penguji[];
    kelompok: Kelompok[];
    penilaian: Record<string, PenilaianPeserta>;
    settings: AppSettings;
  },
  remote: SyncPayload | null,
  currentUser: AuthUser,
  googleEmail?: string
): {
  payload: SyncPayload;
  report: SyncMergeReport;
} {
  // Take local data directly as the authoritative state
  const cleanPenilaian: Record<string, PenilaianPeserta> = {};
  const validPesertaIds = new Set(local.peserta.map((p) => p.id));

  // Only retain penilaian for existing local participants
  Object.entries(local.penilaian).forEach(([pId, val]) => {
    if (validPesertaIds.has(pId)) {
      cleanPenilaian[pId] = val;
    }
  });

  const nextVersion = remote ? (remote.version || 1) + 1 : 1;

  const payload: SyncPayload = {
    version: nextVersion,
    appName: 'Penilaian Pramuka Garuda Kemranjen-Siaga',
    lastSyncedAt: new Date().toISOString(),
    syncedBy: {
      role: 'admin',
      username: currentUser.username,
      displayName: currentUser.displayName,
      googleEmail,
    },
    peserta: local.peserta,
    penguji: local.penguji,
    kelompok: local.kelompok,
    penilaian: cleanPenilaian,
    settings: local.settings,
    meta: {
      isFullAdminSync: true,
      note: `Sinkronisasi Penghapusan (Admin Master Override) oleh ${currentUser.displayName}`,
    },
  };

  const remotePesertaCount = remote?.peserta?.length || 0;
  const deletedPesertaCount = Math.max(0, remotePesertaCount - local.peserta.length);

  return {
    payload,
    report: {
      timestamp: payload.lastSyncedAt,
      mode: 'admin_deletion_sync',
      peserta: {
        added: 0,
        updated: deletedPesertaCount,
        total: local.peserta.length,
      },
      penguji: {
        added: 0,
        updated: 0,
        total: local.penguji.length,
      },
      kelompok: {
        added: 0,
        updated: 0,
        total: local.kelompok.length,
      },
      penilaian: {
        added: 0,
        updated: 0,
        total: Object.keys(cleanPenilaian).length,
      },
      remoteLastUpdated: remote?.lastSyncedAt,
      remoteUpdatedBy: remote?.syncedBy?.displayName,
    },
  };
}
