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
    targetFolderId?: string;
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

export interface FolderAccessStatus {
  checked: boolean;
  accessible: boolean;
  canWrite: boolean;
  name?: string;
  error?: string;
  isSharedDrive?: boolean;
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
  storageLocation?: string;
}

/**
 * Check if user has access to target Google Drive folder
 * Uses supportsAllDrives=true to ensure Shared Drives & shared links work
 */
export async function verifyFolderAccess(
  accessToken: string,
  folderId: string = GOOGLE_DRIVE_FOLDER_ID
): Promise<FolderAccessStatus> {
  try {
    const url = `https://www.googleapis.com/drive/v3/files/${folderId}?supportsAllDrives=true&fields=id,name,capabilities,webViewLink,driveId,shared`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (res.status === 404) {
      return {
        checked: true,
        accessible: false,
        canWrite: false,
        error:
          'Folder tidak ditemukan atau belum dibagikan ke akun Google ini. Pastikan Anda telah membuka tautan folder di browser dengan akun tersebut setidaknya satu kali.',
      };
    }

    if (res.status === 403) {
      return {
        checked: true,
        accessible: false,
        canWrite: false,
        error:
          'Akses folder ditolak oleh Google. Pastikan akun Google Anda telah diberikan izin akses.',
      };
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return {
        checked: true,
        accessible: false,
        canWrite: false,
        error: err.error?.message || `Gagal mengakses folder (Status: ${res.status})`,
      };
    }

    const data = await res.json();
    const canWrite =
      data.capabilities?.canAddChildren === true ||
      data.capabilities?.canEdit === true;

    return {
      checked: true,
      accessible: true,
      canWrite,
      name: data.name || 'Folder Penilaian Pramuka Garuda',
      isSharedDrive: !!data.driveId,
    };
  } catch (e: any) {
    return {
      checked: true,
      accessible: false,
      canWrite: false,
      error: e.message || 'Koneksi ke Google Drive terputus.',
    };
  }
}

/**
 * List files in the target folder with supportsAllDrives
 */
export async function listFolderFiles(
  accessToken: string,
  folderId: string = GOOGLE_DRIVE_FOLDER_ID
): Promise<DriveFileInfo[]> {
  try {
    const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const fields = encodeURIComponent(
      'files(id, name, mimeType, modifiedTime, size, description, webViewLink)'
    );
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&orderBy=modifiedTime desc&pageSize=50&supportsAllDrives=true&includeItemsFromAllDrives=true`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('Folder file query error:', err);
      // Fallback search by name if parent query is not permitted
      return await searchMasterFilesByName(accessToken);
    }

    const data = await res.json();
    return data.files || [];
  } catch (e) {
    console.warn('listFolderFiles failed, trying fallback search:', e);
    return await searchMasterFilesByName(accessToken);
  }
}

/**
 * Fallback: Search for master sync or backup files accessible by this user
 */
async function searchMasterFilesByName(
  accessToken: string
): Promise<DriveFileInfo[]> {
  try {
    const query = encodeURIComponent(
      `name contains 'pramuka_garuda' and trashed = false`
    );
    const fields = encodeURIComponent(
      'files(id, name, mimeType, modifiedTime, size, description, webViewLink)'
    );
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&orderBy=modifiedTime desc&pageSize=30&supportsAllDrives=true&includeItemsFromAllDrives=true`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.files || [];
  } catch (err) {
    return [];
  }
}

/**
 * Find the primary master sync file
 */
export async function findMasterSyncFile(
  accessToken: string,
  folderId: string = GOOGLE_DRIVE_FOLDER_ID
): Promise<DriveFileInfo | null> {
  const files = await listFolderFiles(accessToken, folderId);
  const master = files.find((f) => f.name === MASTER_SYNC_FILENAME);
  if (master) return master;

  // Fallback: Check if there's any master sync file accessible in Drive
  const fallbackFiles = await searchMasterFilesByName(accessToken);
  return fallbackFiles.find((f) => f.name === MASTER_SYNC_FILENAME) || null;
}

/**
 * Download JSON file content from Drive
 */
export async function downloadJsonFile<T = any>(
  accessToken: string,
  fileId: string
): Promise<T> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err.error?.message || `Gagal mengunduh file dari Google Drive (${res.status})`
    );
  }

  return await res.json();
}

/**
 * Upload a JSON file to Google Drive.
 * If target folder is write-restricted, gracefully falls back to user's root Drive with metadata.
 */
export async function uploadJsonToDrive(
  accessToken: string,
  fileName: string,
  payload: any,
  description?: string,
  folderId: string = GOOGLE_DRIVE_FOLDER_ID
): Promise<{ file: DriveFileInfo; usedFallback: boolean }> {
  const fileContent = JSON.stringify(payload, null, 2);
  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;

  // First attempt: Upload directly to designated target folder
  try {
    const metadataWithParent = {
      name: fileName,
      mimeType: 'application/json',
      parents: [folderId],
      description: description || 'Data Penilaian Pramuka Garuda Banyumas',
    };

    const multipartBody =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadataWithParent) +
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      fileContent +
      closeDelim;

    const res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,modifiedTime,size,description,webViewLink',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      }
    );

    if (res.ok) {
      const created = await res.json();
      return { file: created, usedFallback: false };
    }

    const err = await res.json().catch(() => ({}));
    console.warn('Upload to parent folder failed with status', res.status, err);

    // If error is permission or not found, try fallback
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(err.error?.message || `Gagal unggah file (${res.status})`);
    }
  } catch (err: any) {
    console.warn('Initial folder upload threw, proceeding to fallback:', err);
  }

  // Fallback attempt: Upload to user's personal Google Drive root
  const fallbackMetadata = {
    name: fileName,
    mimeType: 'application/json',
    description: `[Pramuka Garuda] ${description || 'Cadangan Data'} (Disimpan di Google Drive Utama)`,
  };

  const fallbackBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(fallbackMetadata) +
    delimiter +
    'Content-Type: application/json\r\n\r\n' +
    fileContent +
    closeDelim;

  const fallbackRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,modifiedTime,size,description,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: fallbackBody,
    }
  );

  if (!fallbackRes.ok) {
    const err = await fallbackRes.json().catch(() => ({}));
    throw new Error(
      err.error?.message ||
        `Gagal mengunggah ke Google Drive (Status: ${fallbackRes.status})`
    );
  }

  const fallbackCreated = await fallbackRes.json();
  return { file: fallbackCreated, usedFallback: true };
}

/**
 * Update existing JSON file content in Google Drive
 */
export async function updateJsonInDrive(
  accessToken: string,
  fileId: string,
  payload: any,
  description?: string
): Promise<DriveFileInfo> {
  const fileContent = JSON.stringify(payload, null, 2);

  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`,
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
      err.error?.message ||
        `Gagal memperbarui file di Google Drive (Status: ${res.status})`
    );
  }

  if (description) {
    await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description }),
      }
    ).catch(() => {});
  }

  return await res.json();
}

/**
 * Delete a file in Drive
 */
export async function deleteDriveFile(
  accessToken: string,
  fileId: string
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err.error?.message || `Gagal menghapus file di Drive (${res.status})`
    );
  }
}

// ========================================================
// SMART MERGE & UPDATE ALGORITHM (Data lama tidak terhapus)
// ========================================================

function normalizeKey(str: string): string {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

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

  const getPesertaKey = (p: Peserta) => {
    const no = normalizeKey(p.nomorPeserta);
    if (no) return `no:${no}`;
    const name = normalizeKey(p.nama);
    const pang = normalizeKey(p.pangkalan);
    return `name:${name}_${pang}`;
  };

  (remote.peserta || []).forEach((remP) => {
    mergedPesertaMap.set(getPesertaKey(remP), remP);
  });

  local.peserta.forEach((locP) => {
    const key = getPesertaKey(locP);
    if (mergedPesertaMap.has(key)) {
      const remP = mergedPesertaMap.get(key)!;
      const merged: Peserta = {
        id: locP.id || remP.id,
        nomorPeserta: locP.nomorPeserta || remP.nomorPeserta,
        nama: locP.nama.length >= (remP.nama || '').length ? locP.nama : remP.nama,
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
  const mergedPenilaian: Record<string, PenilaianPeserta> = {};
  const remotePenilaian = remote.penilaian || {};
  const localPenilaian = local.penilaian || {};

  const calculateTotalScore = (pen?: PenilaianPeserta) => {
    if (!pen) return -1;
    const adminCount = (pen.administrasi || []).filter((a) => a.tersedia).length;
    const wawancaraScore = (pen.wawancara || []).reduce(
      (sum, w) => sum + (w.poin || 0),
      0
    );
    return adminCount + wawancaraScore;
  };

  mergedPeserta.forEach((p) => {
    const canonicalId = p.id;
    let locPen = localPenilaian[canonicalId];
    if (!locPen) {
      const origLocal = local.peserta.find(
        (lp) => getPesertaKey(lp) === getPesertaKey(p)
      );
      if (origLocal) locPen = localPenilaian[origLocal.id];
    }

    let remPen: PenilaianPeserta | undefined = undefined;
    for (const [rId, rVal] of Object.entries(remotePenilaian)) {
      if (rId === canonicalId) {
        remPen = rVal;
        break;
      }
    }
    if (!remPen) {
      const origRemote = (remote.peserta || []).find(
        (rp) => getPesertaKey(rp) === getPesertaKey(p)
      );
      if (origRemote && remotePenilaian[origRemote.id]) {
        remPen = remotePenilaian[origRemote.id];
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
 * ADMIN DELETION SYNC
 * Syncs deletions made by admin so Google Drive accurately mirrors the admin state.
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
  const cleanPenilaian: Record<string, PenilaianPeserta> = {};
  const validPesertaIds = new Set(local.peserta.map((p) => p.id));

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
