import React, { useState, useEffect, useRef } from 'react';
import {
  Peserta,
  Penguji,
  Kelompok,
  PenilaianPeserta,
  AppSettings,
  AuthUser,
} from '../types';
import {
  signInWithGoogle,
  signOutGoogle,
  getGoogleAccessToken,
  getCurrentGoogleUser,
  getCurrentGoogleProfile,
  hasActiveGoogleToken,
  initGoogleAuth,
  GoogleUserProfile,
} from '../utils/googleAuth';
import {
  GOOGLE_DRIVE_FOLDER_ID,
  GOOGLE_DRIVE_FOLDER_URL,
  MASTER_SYNC_FILENAME,
  verifyFolderAccess,
  findMasterSyncFile,
  downloadJsonFile,
  uploadJsonToDrive,
  updateJsonInDrive,
  listFolderFiles,
  mergeAndUpdateAppData,
  buildAdminDeletionSyncPayload,
  SyncPayload,
  SyncMergeReport,
  DriveFileInfo,
  FolderAccessStatus,
} from '../utils/googleDrive';
import {
  X,
  Cloud,
  RefreshCw,
  UploadCloud,
  DownloadCloud,
  FolderCheck,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  ShieldAlert,
  FileJson,
  Layers,
  Sparkles,
  Info,
  Key,
  FolderCog,
  FileDown,
  FileUp,
} from 'lucide-react';

interface DriveSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: AuthUser | null;
  pesertaList: Peserta[];
  pengujiList: Penguji[];
  kelompokList: Kelompok[];
  penilaianMap: Record<string, PenilaianPeserta>;
  settings: AppSettings;
  onApplySyncData: (
    newPeserta: Peserta[],
    newPenguji: Penguji[],
    newKelompok: Kelompok[],
    newPenilaian: Record<string, PenilaianPeserta>,
    newSettings?: AppSettings
  ) => void;
}

export const DriveSyncModal: React.FC<DriveSyncModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  pesertaList,
  pengujiList,
  kelompokList,
  penilaianMap,
  settings,
  onApplySyncData,
}) => {
  // Auth state
  const [googleUser, setGoogleUser] = useState(getCurrentGoogleUser());
  const [googleProfile, setGoogleProfile] = useState<GoogleUserProfile | null>(
    getCurrentGoogleProfile()
  );
  const [hasToken, setHasToken] = useState(hasActiveGoogleToken());
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Folder configuration & diagnostic state
  const [targetFolderId, setTargetFolderId] = useState<string>(GOOGLE_DRIVE_FOLDER_ID);
  const [showFolderEdit, setShowFolderEdit] = useState(false);
  const [customFolderInput, setCustomFolderInput] = useState(GOOGLE_DRIVE_FOLDER_ID);
  const [folderCheck, setFolderCheck] = useState<FolderAccessStatus>({
    checked: false,
    accessible: false,
    canWrite: false,
  });

  // Sync / Operation states
  const [activeTab, setActiveTab] = useState<'sync' | 'backups' | 'offline' | 'info'>('sync');
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncMessage, setSyncMessage] = useState<string>('');
  const [lastReport, setLastReport] = useState<SyncMergeReport | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);

  // Backup files list in folder
  const [backupFiles, setBackupFiles] = useState<DriveFileInfo[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);

  // File import ref for offline JSON
  const offlineFileInputRef = useRef<HTMLInputElement>(null);

  // Confirmation dialog state for destructive/admin operations
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    warningText?: string;
    confirmButtonText: string;
    onConfirm: () => Promise<void>;
  } | null>(null);

  const isAdmin = currentUser?.role === 'admin';

  // Watch Google auth changes
  useEffect(() => {
    const unsubscribe = initGoogleAuth((user, token, profile) => {
      setGoogleUser(user);
      setGoogleProfile(profile);
      const tokenActive = !!token;
      setHasToken(tokenActive);

      if (token) {
        checkFolder(token, targetFolderId);
      } else {
        setFolderCheck({ checked: false, accessible: false, canWrite: false });
      }
    });
    return () => unsubscribe();
  }, [targetFolderId]);

  // When modal opens, refresh folder diagnosis if token is active
  useEffect(() => {
    if (isOpen) {
      const token = getGoogleAccessToken();
      if (token) {
        checkFolder(token, targetFolderId);
        loadBackups(token);
      }
    }
  }, [isOpen, targetFolderId]);

  const checkFolder = async (token: string, folderId: string) => {
    const res = await verifyFolderAccess(token, folderId);
    setFolderCheck(res);
  };

  const loadBackups = async (token?: string) => {
    try {
      setLoadingBackups(true);
      const accToken = token || getGoogleAccessToken();
      if (!accToken) return;
      const files = await listFolderFiles(accToken, targetFolderId);
      setBackupFiles(files);
    } catch (e: any) {
      console.warn('Error loading backup list:', e);
    } finally {
      setLoadingBackups(false);
    }
  };

  // Google Login Handler (Called directly on user gesture)
  const handleGoogleSignIn = async () => {
    try {
      setIsAuthenticating(true);
      setErrorMessage(null);
      setWarningMessage(null);

      const res = await signInWithGoogle();
      if (res?.accessToken) {
        setHasToken(true);
        if (res.user) setGoogleUser(res.user);
        if (res.profile) setGoogleProfile(res.profile);
        await checkFolder(res.accessToken, targetFolderId);
        await loadBackups(res.accessToken);
      }
    } catch (err: any) {
      setErrorMessage(
        err.message ||
          'Gagal masuk dengan akun Google. Pastikan izin Google Drive disetujui.'
      );
    } finally {
      setIsAuthenticating(false);
    }
  };

  // Google Sign Out Handler
  const handleGoogleSignOut = async () => {
    try {
      await signOutGoogle();
      setGoogleUser(null);
      setGoogleProfile(null);
      setHasToken(false);
      setFolderCheck({ checked: false, accessible: false, canWrite: false });
      setBackupFiles([]);
      setSyncStatus('idle');
      setLastReport(null);
      setWarningMessage(null);
    } catch (err: any) {
      console.error('Sign out error:', err);
    }
  };

  // ==========================================================
  // 1. SINKRONISASI CERDAS (MERGE & UPDATE) - SEMUA PENGGUNA
  // ==========================================================
  const handleMergeAndUpdateSync = async () => {
    if (!currentUser) return;
    setErrorMessage(null);
    setWarningMessage(null);
    setSyncStatus('syncing');
    setSyncMessage('Memeriksa token & izin Google Drive...');

    try {
      let accessToken = getGoogleAccessToken();
      if (!accessToken) {
        setSyncMessage('Membuka jendela otorisasi akun Google...');
        const authRes = await signInWithGoogle();
        if (!authRes?.accessToken) {
          throw new Error('Otorisasi Google dibatalkan atau tidak ada token.');
        }
        accessToken = authRes.accessToken;
      }

      setSyncMessage('Mengunduh data master dari Google Drive...');
      const masterFile = await findMasterSyncFile(accessToken, targetFolderId);
      let remotePayload: SyncPayload | null = null;

      if (masterFile) {
        try {
          remotePayload = await downloadJsonFile<SyncPayload>(accessToken, masterFile.id);
        } catch (e: any) {
          console.warn('Gagal membaca remote master payload, menginisialisasi berkas baru', e);
        }
      }

      setSyncMessage('Menggabungkan data lokal & cloud secara cerdas (Merge & Update)...');
      const userEmail = googleProfile?.email || googleUser?.email || undefined;
      const { merged, report } = mergeAndUpdateAppData(
        {
          peserta: pesertaList,
          penguji: pengujiList,
          kelompok: kelompokList,
          penilaian: penilaianMap,
          settings,
        },
        remotePayload,
        currentUser,
        userEmail
      );

      setSyncMessage('Menyimpan data hasil penggabungan ke Google Drive...');
      let usedFallback = false;

      if (masterFile) {
        await updateJsonInDrive(
          accessToken,
          masterFile.id,
          merged,
          `Master Sync diperbarui oleh ${currentUser.displayName} (${currentUser.role})`
        );
      } else {
        const uploadResult = await uploadJsonToDrive(
          accessToken,
          MASTER_SYNC_FILENAME,
          merged,
          'Master Data Sinkronisasi Pramuka Garuda Banyumas',
          targetFolderId
        );
        usedFallback = uploadResult.usedFallback;
      }

      // Terapkan ke state aplikasi lokal
      onApplySyncData(
        merged.peserta,
        merged.penguji,
        merged.kelompok,
        merged.penilaian,
        merged.settings
      );

      setLastReport(report);
      setSyncStatus('success');

      if (usedFallback) {
        setWarningMessage(
          'Catatan: Folder bersama utama hanya memiliki izin Lihat Saja (Viewer), sehingga data disinkronkan & disimpan dengan aman di Google Drive akun Anda.'
        );
      }

      setSyncMessage('Sinkronisasi Merge & Update Berhasil!');
      loadBackups(accessToken);
    } catch (err: any) {
      console.error('Merge sync error:', err);
      setSyncStatus('error');
      setErrorMessage(
        err.message || 'Terjadi kendala saat melakukan sinkronisasi dengan Google Drive.'
      );
    }
  };

  // ==========================================================
  // 2. SINKRONISASI PENGHAPUSAN (KHUSUS ADMIN)
  // ==========================================================
  const triggerAdminDeletionSync = () => {
    if (!isAdmin) return;

    setConfirmDialog({
      isOpen: true,
      title: 'Konfirmasi Sinkronisasi Penghapusan (Admin)',
      message:
        'Anda akan memperbarui master data di Google Drive agar persis sesuai data lokal saat ini. Setiap peserta, penguji, tim, atau nilai yang telah Anda hapus di lokal akan ikut disesuaikan (dihapus) di Google Drive.',
      warningText:
        'PERHATIAN: Tindakan ini memutasi file cloud. Sistem akan otomatis membuat file snapshot cadangan darurat di Google Drive sebelum proses dimulai.',
      confirmButtonText: 'Ya, Lanjutkan Sinkronisasi Penghapusan',
      onConfirm: async () => {
        setConfirmDialog(null);
        await executeAdminDeletionSync();
      },
    });
  };

  const executeAdminDeletionSync = async () => {
    if (!currentUser || !isAdmin) return;
    setErrorMessage(null);
    setWarningMessage(null);
    setSyncStatus('syncing');
    setSyncMessage('Menyiapkan otorisasi Admin Google Drive...');

    try {
      let accessToken = getGoogleAccessToken();
      if (!accessToken) {
        setSyncMessage('Membuka jendela otorisasi Google...');
        const authRes = await signInWithGoogle();
        if (!authRes?.accessToken) {
          throw new Error('Otorisasi Google dibatalkan.');
        }
        accessToken = authRes.accessToken;
      }

      setSyncMessage('Memeriksa master cloud dan membuat salinan snapshot pengaman...');
      const masterFile = await findMasterSyncFile(accessToken, targetFolderId);
      let remotePayload: SyncPayload | null = null;

      if (masterFile) {
        try {
          remotePayload = await downloadJsonFile<SyncPayload>(accessToken, masterFile.id);
          const snapshotName = `backup_pengaman_sebelum_sync_admin_${Date.now()}.json`;
          await uploadJsonToDrive(
            accessToken,
            snapshotName,
            remotePayload,
            `Snapshot pengaman darurat sebelum sinkronisasi penghapusan oleh ${currentUser.displayName}`,
            targetFolderId
          );
        } catch (e) {
          console.warn('Gagal membuat snapshot pengaman:', e);
        }
      }

      setSyncMessage('Menyelaraskan master Google Drive dengan data lokal Admin...');
      const userEmail = googleProfile?.email || googleUser?.email || undefined;
      const { payload, report } = buildAdminDeletionSyncPayload(
        {
          peserta: pesertaList,
          penguji: pengujiList,
          kelompok: kelompokList,
          penilaian: penilaianMap,
          settings,
        },
        remotePayload,
        currentUser,
        userEmail
      );

      let usedFallback = false;
      if (masterFile) {
        await updateJsonInDrive(
          accessToken,
          masterFile.id,
          payload,
          `Master Sync diselaraskan dengan data Admin oleh ${currentUser.displayName}`
        );
      } else {
        const uploadResult = await uploadJsonToDrive(
          accessToken,
          MASTER_SYNC_FILENAME,
          payload,
          'Master Data Sinkronisasi Pramuka Garuda Banyumas (Admin Overwrite)',
          targetFolderId
        );
        usedFallback = uploadResult.usedFallback;
      }

      onApplySyncData(
        payload.peserta,
        payload.penguji,
        payload.kelompok,
        payload.penilaian,
        payload.settings
      );

      setLastReport(report);
      setSyncStatus('success');

      if (usedFallback) {
        setWarningMessage(
          'Catatan: Folder bersama utama hanya memiliki izin Lihat Saja, master data telah diselaraskan di Google Drive akun Anda.'
        );
      }

      setSyncMessage(
        'Sinkronisasi Penghapusan Berhasil! Data Google Drive telah disesuaikan dengan data lokal Admin.'
      );
      loadBackups(accessToken);
    } catch (err: any) {
      console.error('Admin deletion sync error:', err);
      setSyncStatus('error');
      setErrorMessage(
        err.message || 'Gagal menyinkronkan data penghapusan ke Google Drive.'
      );
    }
  };

  // ==========================================================
  // 3. BUAT CADANGAN MANUAL CLOUD (MANUAL BACKUP)
  // ==========================================================
  const handleCreateManualBackup = async () => {
    if (!currentUser) return;
    setErrorMessage(null);
    setWarningMessage(null);
    setSyncStatus('syncing');
    setSyncMessage('Membuat berkas cadangan lengkap...');

    try {
      let accessToken = getGoogleAccessToken();
      if (!accessToken) {
        const authRes = await signInWithGoogle();
        if (!authRes?.accessToken) throw new Error('Autentikasi Google dibatalkan.');
        accessToken = authRes.accessToken;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const fileName = `cadangan_pramuka_garuda_${timestamp}.json`;
      const userEmail = googleProfile?.email || googleUser?.email || undefined;

      const backupPayload: SyncPayload = {
        version: 1,
        appName: 'Penilaian Pramuka Garuda Kemranjen-Siaga',
        lastSyncedAt: new Date().toISOString(),
        syncedBy: {
          role: currentUser.role,
          username: currentUser.username,
          displayName: currentUser.displayName,
          googleEmail: userEmail,
        },
        peserta: pesertaList,
        penguji: pengujiList,
        kelompok: kelompokList,
        penilaian: penilaianMap,
        settings,
        meta: {
          note: `Cadangan manual dibuat oleh ${currentUser.displayName}`,
          targetFolderId,
        },
      };

      const uploadResult = await uploadJsonToDrive(
        accessToken,
        fileName,
        backupPayload,
        `Cadangan manual oleh ${currentUser.displayName}`,
        targetFolderId
      );

      setSyncStatus('success');
      if (uploadResult.usedFallback) {
        setWarningMessage(
          'Catatan: Berkas cadangan berhasil disimpan di Google Drive akun Anda karena folder tujuan utama berstatus Lihat Saja.'
        );
      }
      setSyncMessage(`Cadangan "${fileName}" berhasil disimpan di Google Drive!`);
      loadBackups(accessToken);
    } catch (err: any) {
      setSyncStatus('error');
      setErrorMessage(err.message || 'Gagal membuat cadangan ke Google Drive.');
    }
  };

  // ==========================================================
  // 4. PULIHKAN DARI FILE CADANGAN (RESTORE)
  // ==========================================================
  const triggerRestoreFile = (file: DriveFileInfo) => {
    setConfirmDialog({
      isOpen: true,
      title: `Konfirmasi Pemulihan: ${file.name}`,
      message: `Data aplikasi akan diperbarui dengan data dari berkas "${file.name}" (diperbarui: ${
        file.modifiedTime ? new Date(file.modifiedTime).toLocaleString('id-ID') : '-'
      }).`,
      warningText:
        'Sistem akan menyatukan data dengan teknik Merge & Update sehingga data lokal tetap aman dan nilai-nilai baru diintegrasikan.',
      confirmButtonText: 'Pulihkan & Satukan (Merge)',
      onConfirm: async () => {
        setConfirmDialog(null);
        await executeRestoreFile(file);
      },
    });
  };

  const executeRestoreFile = async (file: DriveFileInfo) => {
    if (!currentUser) return;
    setSyncStatus('syncing');
    setSyncMessage(`Mengunduh berkas "${file.name}"...`);

    try {
      const accessToken = getGoogleAccessToken();
      if (!accessToken) throw new Error('Token Google Drive tidak tersedia.');

      const remoteData = await downloadJsonFile<SyncPayload>(accessToken, file.id);
      if (!remoteData || !remoteData.peserta) {
        throw new Error('Format berkas cadangan tidak valid.');
      }

      const userEmail = googleProfile?.email || googleUser?.email || undefined;
      const { merged, report } = mergeAndUpdateAppData(
        {
          peserta: pesertaList,
          penguji: pengujiList,
          kelompok: kelompokList,
          penilaian: penilaianMap,
          settings,
        },
        remoteData,
        currentUser,
        userEmail
      );

      onApplySyncData(
        merged.peserta,
        merged.penguji,
        merged.kelompok,
        merged.penilaian,
        merged.settings
      );

      setLastReport(report);
      setSyncStatus('success');
      setSyncMessage(`Data berhasil dipulihkan dari "${file.name}"!`);
    } catch (err: any) {
      setSyncStatus('error');
      setErrorMessage(err.message || 'Gagal memulihkan berkas cadangan.');
    }
  };

  // ==========================================================
  // 5. EKSPOR & IMPOR FILE OFFLINE (RESILIENSI LAPANGAN)
  // ==========================================================
  const handleExportOfflineJson = () => {
    const payload: SyncPayload = {
      version: 1,
      appName: 'Penilaian Pramuka Garuda Kemranjen-Siaga',
      lastSyncedAt: new Date().toISOString(),
      syncedBy: {
        role: currentUser?.role || 'penguji',
        username: currentUser?.username || 'user',
        displayName: currentUser?.displayName || 'Pengguna',
      },
      peserta: pesertaList,
      penguji: pengujiList,
      kelompok: kelompokList,
      penilaian: penilaianMap,
      settings,
      meta: {
        note: 'Ekspor berkas master JSON offline',
      },
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Pramuka_Garuda_Master_Data_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportOfflineJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUser) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (!parsed.peserta || !Array.isArray(parsed.peserta)) {
          alert('Format berkas JSON tidak sesuai struktur data Pramuka Garuda.');
          return;
        }

        const { merged, report } = mergeAndUpdateAppData(
          {
            peserta: pesertaList,
            penguji: pengujiList,
            kelompok: kelompokList,
            penilaian: penilaianMap,
            settings,
          },
          parsed,
          currentUser
        );

        onApplySyncData(
          merged.peserta,
          merged.penguji,
          merged.kelompok,
          merged.penilaian,
          merged.settings
        );

        setLastReport(report);
        setSyncStatus('success');
        setSyncMessage(`Berkas offline "${file.name}" berhasil digabungkan (Merge)!`);
      } catch (err: any) {
        alert(`Gagal membaca berkas JSON: ${err.message}`);
      }
    };
    reader.readAsText(file);
    if (e.target) e.target.value = '';
  };

  if (!isOpen) return null;

  const displayName =
    googleProfile?.name ||
    googleUser?.displayName ||
    googleProfile?.email ||
    googleUser?.email ||
    'Pengguna Google';
  const displayEmail = googleProfile?.email || googleUser?.email || '';
  const displayPhoto = googleProfile?.picture || googleUser?.photoURL;

  return (
    <div className="fixed inset-0 z-50 bg-stone-950/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 print:hidden animate-in fade-in">
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full p-5 sm:p-7 border border-stone-200 max-h-[92vh] overflow-y-auto flex flex-col">
        {/* Header Modal */}
        <div className="flex items-center justify-between pb-4 border-b border-stone-200 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-700">
              <Cloud className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-black text-stone-900 tracking-tight uppercase">
                  Sinkronisasi Google Drive
                </h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                  Resmi Kwarran Kemranjen
                </span>
              </div>
              <p className="text-xs text-stone-500">
                Penyelarasan data peserta &amp; penilaian dengan proteksi Merge and Update
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Akun Google & Status Koneksi */}
        <div className="my-4 p-4 rounded-xl bg-stone-50 border border-stone-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {hasToken && (googleUser || googleProfile) ? (
              <>
                {displayPhoto ? (
                  <img
                    src={displayPhoto}
                    alt={displayName}
                    className="w-10 h-10 rounded-full border border-stone-300 shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-emerald-100 border border-emerald-300 text-emerald-800 font-bold flex items-center justify-center text-sm shrink-0">
                    {displayName.charAt(0) || 'G'}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-bold text-xs sm:text-sm text-stone-900 truncate">
                      {displayName}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded-md border border-emerald-200">
                      <CheckCircle2 className="w-3 h-3" />
                      Google Drive Terhubung
                    </span>
                  </div>
                  <div className="text-[11px] text-stone-500 truncate">{displayEmail}</div>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                  <Key className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-xs sm:text-sm text-stone-800">
                    Otorisasi Google Drive Diperlukan
                  </div>
                  <div className="text-[11px] text-stone-500">
                    Sambungkan akun Google untuk membaca &amp; menyimpan data penilaian ke folder
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            {hasToken ? (
              <button
                type="button"
                onClick={handleGoogleSignOut}
                className="px-3 py-1.5 rounded-lg border border-stone-300 hover:bg-stone-100 text-stone-700 text-xs font-semibold transition-colors cursor-pointer"
              >
                Ganti Akun
              </button>
            ) : (
              <button
                type="button"
                disabled={isAuthenticating}
                onClick={handleGoogleSignIn}
                className="w-full sm:w-auto px-4 py-2 bg-white hover:bg-stone-50 text-stone-800 font-bold text-xs rounded-xl border border-stone-300 shadow-xs flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <svg
                  version="1.1"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 48 48"
                  className="w-4 h-4 shrink-0"
                >
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
                <span>{isAuthenticating ? 'Menghubungkan...' : 'Sambungkan Google Drive'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Diagnostik Folder Target Bar */}
        <div className="mb-4 p-3 rounded-xl bg-amber-50/70 border border-amber-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 text-xs shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FolderCheck className="w-4 h-4 text-amber-700 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-bold text-stone-900">Folder Sasaran:</span>
                <span className="text-stone-700 font-mono text-[11px] truncate max-w-[200px]">
                  {targetFolderId}
                </span>
                {folderCheck.checked && (
                  <span
                    className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                      folderCheck.accessible && folderCheck.canWrite
                        ? 'bg-emerald-100 text-emerald-800'
                        : folderCheck.accessible
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-rose-100 text-rose-800'
                    }`}
                  >
                    {folderCheck.accessible && folderCheck.canWrite
                      ? 'Siap Tulis & Baca'
                      : folderCheck.accessible
                      ? 'Akses Baca (Viewer)'
                      : 'Folder Belum Dibagikan'}
                  </span>
                )}
              </div>
              {folderCheck.name && (
                <div className="text-[11px] text-stone-500 truncate">
                  Nama Folder: {folderCheck.name}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setShowFolderEdit(!showFolderEdit)}
              className="text-[11px] font-bold text-stone-600 hover:text-stone-900 underline cursor-pointer flex items-center gap-1"
            >
              <FolderCog className="w-3.5 h-3.5" />
              <span>{showFolderEdit ? 'Tutup Pengaturan' : 'Sesuaikan Folder'}</span>
            </button>

            <a
              href={`https://drive.google.com/drive/folders/${targetFolderId}?usp=sharing`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-bold text-amber-800 hover:text-amber-950 hover:underline text-[11px]"
            >
              <span>Buka di Drive</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>

        {/* Input Ubah ID Folder (Opsional) */}
        {showFolderEdit && (
          <div className="mb-4 p-3.5 rounded-xl bg-stone-100 border border-stone-200 text-xs space-y-2 animate-in fade-in">
            <div className="font-bold text-stone-800">Atur ID Folder Google Drive:</div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={customFolderInput}
                onChange={(e) => setCustomFolderInput(e.target.value)}
                placeholder="Contoh: 1rxfTvUjeKbqYR8qB5nZYflihb2f_ezxD"
                className="flex-1 bg-white border border-stone-300 rounded-lg px-3 py-1.5 text-xs font-mono"
              />
              <button
                type="button"
                onClick={() => {
                  const cleaned = customFolderInput.trim() || GOOGLE_DRIVE_FOLDER_ID;
                  setTargetFolderId(cleaned);
                  const token = getGoogleAccessToken();
                  if (token) checkFolder(token, cleaned);
                  setShowFolderEdit(false);
                }}
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg cursor-pointer"
              >
                Simpan &amp; Uji
              </button>
              <button
                type="button"
                onClick={() => {
                  setCustomFolderInput(GOOGLE_DRIVE_FOLDER_ID);
                  setTargetFolderId(GOOGLE_DRIVE_FOLDER_ID);
                  const token = getGoogleAccessToken();
                  if (token) checkFolder(token, GOOGLE_DRIVE_FOLDER_ID);
                  setShowFolderEdit(false);
                }}
                className="px-2.5 py-1.5 bg-stone-200 hover:bg-stone-300 text-stone-700 font-semibold rounded-lg cursor-pointer"
              >
                Reset Bawaan
              </button>
            </div>
          </div>
        )}

        {/* Tab Navigasi Modal */}
        <div className="flex items-center gap-2 mb-4 p-1 bg-stone-100 rounded-xl border border-stone-200 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('sync')}
            className={`flex-1 py-1.5 px-3 text-xs sm:text-sm font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'sync'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900 hover:bg-stone-200/60'
            }`}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Sinkronisasi Online</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('backups');
              const t = getGoogleAccessToken();
              if (t) loadBackups(t);
            }}
            className={`flex-1 py-1.5 px-3 text-xs sm:text-sm font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'backups'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900 hover:bg-stone-200/60'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Riwayat &amp; Cadangan</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('offline')}
            className={`flex-1 py-1.5 px-3 text-xs sm:text-sm font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'offline'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900 hover:bg-stone-200/60'
            }`}
          >
            <FileJson className="w-3.5 h-3.5" />
            <span>Berkas Offline</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('info')}
            className={`flex-1 py-1.5 px-3 text-xs sm:text-sm font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'info'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900 hover:bg-stone-200/60'
            }`}
          >
            <Info className="w-3.5 h-3.5" />
            <span>Petunjuk</span>
          </button>
        </div>

        {/* Warning message banner */}
        {warningMessage && (
          <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-300 flex items-start gap-2.5 text-xs text-amber-900 animate-in fade-in">
            <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <div className="flex-1 font-medium">{warningMessage}</div>
          </div>
        )}

        {/* Error message banner */}
        {errorMessage && (
          <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 flex items-start gap-2.5 text-xs text-rose-800 animate-in fade-in">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div className="flex-1 font-medium">{errorMessage}</div>
          </div>
        )}

        {/* Sync Status Banner */}
        {syncStatus === 'syncing' && (
          <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-300 flex items-center gap-2.5 text-xs text-amber-900 animate-in fade-in">
            <RefreshCw className="w-4 h-4 text-amber-600 animate-spin shrink-0" />
            <div className="font-semibold">{syncMessage}</div>
          </div>
        )}

        {syncStatus === 'success' && (
          <div className="mb-4 p-3 rounded-xl bg-emerald-50 border border-emerald-300 flex items-center gap-2.5 text-xs text-emerald-900 animate-in fade-in">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <div className="font-semibold">{syncMessage}</div>
          </div>
        )}

        {/* CONTENT TABS */}
        <div className="flex-1 overflow-y-auto space-y-4">
          {activeTab === 'sync' && (
            <div className="space-y-4">
              {/* OPSI 1: SINKRONISASI CERDAS (MERGE & UPDATE) */}
              <div className="p-4 sm:p-5 rounded-2xl border-2 border-amber-300/80 bg-gradient-to-br from-amber-50/50 to-white space-y-3.5 shadow-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-amber-600 text-white flex items-center justify-center shadow-xs">
                      <RefreshCw className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="font-black text-sm sm:text-base text-stone-900">
                        Sinkronisasi Cerdas (Merge &amp; Update)
                      </h4>
                      <p className="text-[11px] text-amber-900 font-semibold">
                        Aman untuk seluruh Penguji &amp; Admin • Data lama tidak pernah hilang
                      </p>
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wide bg-amber-200 text-amber-950">
                    Standar
                  </span>
                </div>

                <p className="text-xs text-stone-600 leading-relaxed">
                  Menggabungkan data lokal Anda dengan Google Drive secara otomatis. Peserta baru dan nilai yang telah diisi oleh penguji lain akan disatukan tanpa menimpa data yang telah ada.
                </p>

                <div className="pt-2 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={syncStatus === 'syncing'}
                    onClick={handleMergeAndUpdateSync}
                    className="px-4 py-2.5 bg-amber-600 hover:bg-amber-700 active:scale-95 text-white font-bold text-xs sm:text-sm rounded-xl shadow-md shadow-amber-600/20 flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
                    <span>
                      {hasToken ? 'Mulai Sinkronisasi (Merge & Update)' : 'Hubungkan & Sinkronkan'}
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={syncStatus === 'syncing'}
                    onClick={handleCreateManualBackup}
                    className="px-3.5 py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-800 font-semibold text-xs sm:text-sm rounded-xl border border-stone-300 flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <UploadCloud className="w-4 h-4 text-stone-600" />
                    <span>Buat Cadangan File Baru</span>
                  </button>
                </div>
              </div>

              {/* OPSI 2: SINKRONISASI PENGHAPUSAN (KHUSUS ADMIN) */}
              <div
                className={`p-4 sm:p-5 rounded-2xl border ${
                  isAdmin
                    ? 'border-rose-300 bg-rose-50/30'
                    : 'border-stone-200 bg-stone-50/60 opacity-80'
                } space-y-3.5`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shadow-xs ${
                        isAdmin ? 'bg-rose-600 text-white' : 'bg-stone-400 text-white'
                      }`}
                    >
                      <ShieldAlert className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <h4 className="font-black text-sm sm:text-base text-stone-900">
                          Sinkronisasi Penghapusan (Admin Master Override)
                        </h4>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-black uppercase ${
                            isAdmin
                              ? 'bg-rose-100 text-rose-800 border border-rose-300'
                              : 'bg-stone-200 text-stone-600'
                          }`}
                        >
                          Khusus Admin
                        </span>
                      </div>
                      <p className="text-[11px] text-stone-500 font-medium">
                        Menyesuaikan Google Drive agar selaras dengan data yang telah Anda hapus di lokal
                      </p>
                    </div>
                  </div>
                </div>

                <p className="text-xs text-stone-600 leading-relaxed">
                  Gunakan fitur ini jika Administrator Kwarcab telah menghapus peserta yang batal hadir, data penguji lama, atau data tim penilai, dan ingin memastikan data yang dihapus tersebut ikut dihapus dari Google Drive.
                </p>

                {isAdmin ? (
                  <div className="pt-1">
                    <button
                      type="button"
                      disabled={syncStatus === 'syncing'}
                      onClick={triggerAdminDeletionSync}
                      className="px-4 py-2.5 bg-rose-600 hover:bg-rose-700 active:scale-95 text-white font-bold text-xs sm:text-sm rounded-xl shadow-md shadow-rose-600/20 flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50"
                    >
                      <ShieldAlert className="w-4 h-4" />
                      <span>Sinkronisasikan Penghapusan ke Google Drive</span>
                    </button>
                    <p className="text-[11px] text-stone-500 mt-2">
                      * Sistem otomatis membuat file snapshot cadangan darurat di Google Drive sebelum proses penghapusan dilakukan.
                    </p>
                  </div>
                ) : (
                  <div className="p-2.5 rounded-lg bg-stone-100 text-[11px] text-stone-600 flex items-center gap-2">
                    <Info className="w-3.5 h-3.5 text-stone-500 shrink-0" />
                    <span>
                      Anda sedang masuk sebagai <strong>Penguji</strong>. Opsi penyesuaian penghapusan dibatasi untuk Administrator Kwarcab demi mencegah data terhapus tanpa sengaja.
                    </span>
                  </div>
                )}
              </div>

              {/* LAPORAN HASIL SINKRONISASI TERAKHIR */}
              {lastReport && (
                <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 space-y-3 animate-in fade-in">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs font-black text-stone-900 uppercase tracking-wide">
                      <Sparkles className="w-4 h-4 text-amber-600" />
                      <span>Rincian Hasil Sinkronisasi</span>
                    </div>
                    <span className="text-[10px] text-stone-500 font-mono">
                      {new Date(lastReport.timestamp).toLocaleTimeString('id-ID')}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div className="p-2.5 rounded-lg bg-white border border-stone-200">
                      <div className="text-[10px] text-stone-500 font-semibold uppercase">Peserta</div>
                      <div className="text-base font-black text-stone-900">
                        {lastReport.peserta.total}
                      </div>
                      <div className="text-[10px] text-emerald-700 font-medium">
                        +{lastReport.peserta.added} baru • {lastReport.peserta.updated} diupdate
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-white border border-stone-200">
                      <div className="text-[10px] text-stone-500 font-semibold uppercase">Penguji</div>
                      <div className="text-base font-black text-stone-900">
                        {lastReport.penguji.total}
                      </div>
                      <div className="text-[10px] text-emerald-700 font-medium">
                        +{lastReport.penguji.added} baru • {lastReport.penguji.updated} diupdate
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-white border border-stone-200">
                      <div className="text-[10px] text-stone-500 font-semibold uppercase">Tim Penilai</div>
                      <div className="text-base font-black text-stone-900">
                        {lastReport.kelompok.total}
                      </div>
                      <div className="text-[10px] text-emerald-700 font-medium">
                        +{lastReport.kelompok.added} baru • {lastReport.kelompok.updated} diupdate
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-white border border-stone-200">
                      <div className="text-[10px] text-stone-500 font-semibold uppercase">Penilaian</div>
                      <div className="text-base font-black text-stone-900">
                        {lastReport.penilaian.total}
                      </div>
                      <div className="text-[10px] text-emerald-700 font-medium">
                        +{lastReport.penilaian.added} baru • {lastReport.penilaian.updated} diupdate
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'backups' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-stone-200">
                <div className="text-xs font-bold text-stone-800 uppercase tracking-wide">
                  Berkas Cadangan di Google Drive
                </div>
                <button
                  type="button"
                  disabled={loadingBackups}
                  onClick={() => loadBackups()}
                  className="text-xs text-amber-700 hover:text-amber-900 font-bold flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingBackups ? 'animate-spin' : ''}`} />
                  <span>Segarkan</span>
                </button>
              </div>

              {loadingBackups ? (
                <div className="py-8 text-center text-xs text-stone-500 flex items-center justify-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin text-amber-600" />
                  <span>Membaca daftar berkas dari Google Drive...</span>
                </div>
              ) : backupFiles.length === 0 ? (
                <div className="py-8 text-center text-xs text-stone-500">
                  <FileJson className="w-8 h-8 mx-auto text-stone-400 mb-2" />
                  <p>Belum ada berkas cadangan di folder Google Drive ini.</p>
                  <button
                    type="button"
                    onClick={handleCreateManualBackup}
                    className="mt-3 px-3 py-1.5 bg-amber-600 text-white rounded-lg font-bold text-xs inline-flex items-center gap-1 cursor-pointer"
                  >
                    <UploadCloud className="w-3.5 h-3.5" />
                    <span>Buat Cadangan Pertama Sekarang</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {backupFiles.map((file) => {
                    const isMaster = file.name === MASTER_SYNC_FILENAME;
                    return (
                      <div
                        key={file.id}
                        className={`p-3 rounded-xl border flex items-center justify-between gap-3 ${
                          isMaster
                            ? 'border-amber-300 bg-amber-50/40'
                            : 'border-stone-200 bg-white hover:bg-stone-50'
                        }`}
                      >
                        <div className="min-w-0 flex items-center gap-3">
                          <div
                            className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                              isMaster
                                ? 'bg-amber-600 text-white'
                                : 'bg-stone-100 text-stone-600 border border-stone-200'
                            }`}
                          >
                            <FileJson className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-xs text-stone-900 truncate">
                                {file.name}
                              </span>
                              {isMaster && (
                                <span className="px-1.5 py-0.2 bg-amber-200 text-amber-900 text-[9px] font-black rounded-sm uppercase">
                                  Master Data
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-stone-500 flex items-center gap-2">
                              <span>
                                {file.modifiedTime
                                  ? new Date(file.modifiedTime).toLocaleString('id-ID')
                                  : '-'}
                              </span>
                              {file.description && (
                                <span className="truncate max-w-[200px] text-stone-400">
                                  • {file.description}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="shrink-0 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => triggerRestoreFile(file)}
                            className="px-2.5 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-bold transition-colors flex items-center gap-1 cursor-pointer"
                            title="Pulihkan dan satukan data dari file ini"
                          >
                            <DownloadCloud className="w-3.5 h-3.5 text-amber-700" />
                            <span>Pulihkan (Restore)</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'offline' && (
            <div className="space-y-4 text-xs">
              <div className="p-4 rounded-xl bg-amber-50/70 border border-amber-200 space-y-2">
                <div className="font-bold text-amber-950 flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-amber-700" />
                  <span>Pertukaran Berkas Cadangan Offline (Tanpa Internet)</span>
                </div>
                <p className="text-stone-600 leading-relaxed">
                  Jika koneksi internet di lokasi penilaian kurang stabil, panitia dan penguji dapat menukar data menggunakan berkas JSON langsung via flashdisk atau aplikasi pesan.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="p-4 rounded-xl bg-white border border-stone-200 space-y-2.5">
                  <div className="font-bold text-stone-900 flex items-center gap-1.5">
                    <FileDown className="w-4 h-4 text-amber-700" />
                    <span>Ekspor Berkas Master Lokal</span>
                  </div>
                  <p className="text-stone-500 text-[11px] leading-relaxed">
                    Unduh seluruh data peserta, penguji, tim, dan nilai saat ini dalam format berkas master JSON.
                  </p>
                  <button
                    type="button"
                    onClick={handleExportOfflineJson}
                    className="w-full py-2 bg-stone-100 hover:bg-stone-200 text-stone-800 font-bold rounded-lg border border-stone-300 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <DownloadCloud className="w-3.5 h-3.5" />
                    <span>Unduh Master JSON</span>
                  </button>
                </div>

                <div className="p-4 rounded-xl bg-white border border-stone-200 space-y-2.5">
                  <div className="font-bold text-stone-900 flex items-center gap-1.5">
                    <FileUp className="w-4 h-4 text-emerald-700" />
                    <span>Impor &amp; Gabungkan (Merge JSON)</span>
                  </div>
                  <p className="text-stone-500 text-[11px] leading-relaxed">
                    Pilih berkas JSON dari penguji lain. Data akan digabungkan secara cerdas tanpa menghapus data lokal Anda.
                  </p>
                  <input
                    type="file"
                    ref={offlineFileInputRef}
                    accept=".json"
                    onChange={handleImportOfflineJson}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => offlineFileInputRef.current?.click()}
                    className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg shadow-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <UploadCloud className="w-3.5 h-3.5" />
                    <span>Pilih Berkas JSON &amp; Merge</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'info' && (
            <div className="space-y-4 text-xs text-stone-700 leading-relaxed">
              <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 space-y-1.5">
                <div className="font-black text-amber-950 uppercase tracking-wide flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-amber-700" />
                  <span>Prinsip Kerja Sinkronisasi (Merge &amp; Update)</span>
                </div>
                <p>
                  Setiap penguji dapat menguji anak didik di posnya masing-masing. Saat menekan tombol <strong>Mulai Sinkronisasi</strong>:
                </p>
                <ul className="list-disc pl-5 space-y-1 mt-1 text-stone-700 font-medium">
                  <li>Nilai wawancara dan administrasi yang Anda input akan disatukan ke Google Drive.</li>
                  <li>Nilai dari penguji lain untuk peserta lain akan otomatis ditarik dan disatukan ke perangkat Anda.</li>
                  <li>Data peserta lama tidak akan pernah terhapus ataupun tertimpa kosong.</li>
                </ul>
              </div>

              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 space-y-1.5">
                <div className="font-black text-rose-950 uppercase tracking-wide flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 text-rose-700" />
                  <span>Kewenangan Khusus Administrator (Penghapusan)</span>
                </div>
                <p>
                  Jika ada peserta yang dibatalkan pendaftarannya atau data ganda yang dihapus oleh Administrator Kwarcab, gunakan menu <strong>Sinkronisasi Penghapusan</strong> untuk membersihkan data tersebut di cloud.
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-stone-100 border border-stone-200 space-y-1 text-stone-600">
                <div className="font-bold text-stone-900">Folder Google Drive Terhubung:</div>
                <div className="font-mono text-[11px] text-amber-900 break-all select-all">
                  https://drive.google.com/drive/folders/{targetFolderId}?usp=sharing
                </div>
                <div className="pt-1 text-[11px]">
                  ID Folder: <code className="bg-stone-200 px-1 py-0.5 rounded">{targetFolderId}</code>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Modal */}
        <div className="pt-4 border-t border-stone-200 flex items-center justify-between shrink-0">
          <div className="text-[11px] text-stone-500">
            Kwartir Ranting Kemranjen • Kwartir Cabang Banyumas
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-800 font-bold text-xs sm:text-sm rounded-xl transition-colors cursor-pointer"
          >
            Tutup
          </button>
        </div>
      </div>

      {/* CONFIRMATION MODAL FOR DESTRUCTIVE / ADMIN OPERATIONS */}
      {confirmDialog && confirmDialog.isOpen && (
        <div className="fixed inset-0 z-60 bg-stone-950/80 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-stone-300 animate-in fade-in zoom-in-95 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h4 className="font-black text-base text-stone-900">{confirmDialog.title}</h4>
                <p className="text-xs text-stone-600 mt-1 leading-relaxed">{confirmDialog.message}</p>
              </div>
            </div>

            {confirmDialog.warningText && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-[11px] text-rose-800 font-semibold leading-relaxed">
                {confirmDialog.warningText}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-200">
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-xs rounded-xl transition-colors cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => confirmDialog.onConfirm()}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-black text-xs rounded-xl shadow-md shadow-rose-600/20 transition-all cursor-pointer"
              >
                {confirmDialog.confirmButtonText}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
