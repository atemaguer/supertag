export interface CoordinationTlsFiles {
  caFile: string;
  certFile: string;
  keyFile: string;
}
export function generateCoordinationTls(directory: string): Promise<CoordinationTlsFiles>;
export function checkCoordinationTls(url: string, caFile: string): Promise<boolean>;
export function startCoordinationTls(options: {
  targetUrl: string;
  certFile: string;
  keyFile: string;
  host?: string;
  port?: number;
}): Promise<{ url: string; close(): Promise<void> }>;
