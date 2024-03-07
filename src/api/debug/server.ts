import path from "path";
import { window } from "vscode";

import IBMi from "../IBMi";
import IBMiContent from "../IBMiContent";
import * as certificates from "./certificates";
import Instance from "../Instance";

const directory = `/QIBM/ProdData/IBMiDebugService/bin/`;
const detailFile = `package,json`;

const JavaPaths: {[version: string]: string} = {
  "8": `/QOpenSys/QIBM/ProdData/JavaVM/jdk80/64bit`,
  "11": `/QOpenSys/QIBM/ProdData/JavaVM/jdk11/64bit`
}

interface DebugServiceDetails {
  version: string;
  java: string;
}

function getMyJavaHome(javaVersion: string) {
  if (JavaPaths[javaVersion]) {
    return `MY_JAVA_HOME="${JavaPaths[javaVersion]}"`;
  }
}

async function getDebugServiceDetails(content: IBMiContent): Promise<DebugServiceDetails> {
  const detailExists = await content.testStreamFile(path.posix.join(directory, detailFile), "r");
  if (detailExists) {
    const fileContents = await content.downloadStreamfile(path.posix.join(directory, detailFile));
    try {
      return JSON.parse(fileContents);
    } catch (e) {
      // Something very very bad has happened
      console.log(e);
    }
  }

  return {
    version: `1.0.0`,
    java: `8`
  }
}

export async function startup(instance: Instance){
  const connection = instance.getConnection()!;
  const content = instance.getContent()!;
  
  const host = connection.currentHost;
  const details = await getDebugServiceDetails(content);
  const javaHome = getMyJavaHome(details.java);

  const encryptResult = await connection.sendCommand({
    command: `${javaHome} DEBUG_SERVICE_KEYSTORE_PASSWORD="${host}" ${path.posix.join(directory, `encryptKeystorePassword.sh`)} | /usr/bin/tail -n 1`
  });

  if ((encryptResult.code || 0) >= 1) {
    // Usually means it failed.
    // Nice error text comes through as stdout.
    // Real error comes through in stderr.

    throw new Error(encryptResult.stdout || encryptResult.stderr);
  }

  const password = encryptResult.stdout;

  const keystorePath = certificates.getRemoteServerCertPath(connection);

  connection.sendCommand({
    command: `${javaHome} DEBUG_SERVICE_KEYSTORE_PASSWORD="${password}" DEBUG_SERVICE_KEYSTORE_FILE="${keystorePath}" /QOpenSys/usr/bin/nohup "${path.posix.join(directory, `startDebugService.sh`)}"`
  }).then(startResult => {
    if ((startResult.code || 0) >= 1) {
      window.showErrorMessage(startResult.stdout || startResult.stderr);
    }
  });

  return;
}

export async function stop(connection: IBMi) {
  const endResult = await connection.sendCommand({
    command: `${path.posix.join(directory, `stopDebugService.sh`)}`
  });

  if (endResult.code === 0) {
    window.showInformationMessage(`Ended Debug Service.`);
  } else {
    window.showErrorMessage(endResult.stdout || endResult.stderr);
  }
}

export async function getRunningJob(localPort: string, content: IBMiContent): Promise<string | undefined> {
  const rows = await content.runSQL(`select job_name, authorization_name from qsys2.netstat_job_info j where local_port = ${localPort} group by job_name, authorization_name`);

  return (rows.length > 0 ? String(rows[0].JOB_NAME) : undefined);
}

export async function end(instance: Instance): Promise<void> {
  const connection = instance.getConnection()!;
  const content = instance.getContent()!;

  const details = await getDebugServiceDetails(content);
  const javaHome = getMyJavaHome(details.java);

  const endResult = await connection.sendCommand({
    command: `${javaHome} ${path.posix.join(directory, `stopDebugService.sh`)}`
  });

  if (endResult.code && endResult.code >= 0) {
    throw new Error(endResult.stdout || endResult.stderr);
  }
}

/**
 * Gets a list of debug jobs stuck at MSGW in QSYSWRK
 */
export async function getStuckJobs(userProfile: string, content: IBMiContent): Promise<string[]> {
  const sql = [
    `SELECT JOB_NAME`,
    `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(SUBSYSTEM_LIST_FILTER => 'QSYSWRK', CURRENT_USER_LIST_FILTER => '${userProfile.toUpperCase()}')) X`,
    `where JOB_STATUS = 'MSGW'`,
  ].join(` `);

  const jobs = await content.runSQL(sql);
  return jobs.map(row => String(row.JOB_NAME));
}

export function endJobs(jobIds: string[], connection: IBMi) {
  const promises = jobIds.map(id => connection.sendCommand({
    command: `system "ENDJOB JOB(${id}) OPTION(*IMMED)"`
  }));

  return Promise.all(promises);
}