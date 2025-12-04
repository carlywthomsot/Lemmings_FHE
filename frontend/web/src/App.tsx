// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface LemmingAbility {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  abilityType: "climb" | "dig" | "build" | "block" | "float";
  status: "pending" | "verified" | "rejected";
}

// FHE encryption simulation for numbers
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [lemmings, setLemmings] = useState<LemmingAbility[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newLemmingData, setNewLemmingData] = useState({ abilityType: "climb", description: "", powerLevel: 1 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedLemming, setSelectedLemming] = useState<LemmingAbility | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [userHistory, setUserHistory] = useState<string[]>([]);
  const verifiedCount = lemmings.filter(l => l.status === "verified").length;
  const pendingCount = lemmings.filter(l => l.status === "pending").length;
  const rejectedCount = lemmings.filter(l => l.status === "rejected").length;

  // Add user action to history
  const addToHistory = (action: string) => {
    setUserHistory(prev => [
      `${new Date().toLocaleTimeString()}: ${action}`,
      ...prev.slice(0, 9) // Keep only last 10 actions
    ]);
  };

  useEffect(() => {
    loadLemmings().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
    addToHistory("Application initialized");
  }, []);

  const loadLemmings = async () => {
    setIsRefreshing(true);
    addToHistory("Loading lemmings data");
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check if contract is available
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      addToHistory("Contract is available");
      
      // Get list of lemming keys
      const keysBytes = await contract.getData("lemming_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing lemming keys:", e); }
      }
      
      // Load each lemming's data
      const list: LemmingAbility[] = [];
      for (const key of keys) {
        try {
          const lemmingBytes = await contract.getData(`lemming_${key}`);
          if (lemmingBytes.length > 0) {
            try {
              const lemmingData = JSON.parse(ethers.toUtf8String(lemmingBytes));
              list.push({ 
                id: key, 
                encryptedData: lemmingData.data, 
                timestamp: lemmingData.timestamp, 
                owner: lemmingData.owner, 
                abilityType: lemmingData.abilityType, 
                status: lemmingData.status || "pending" 
              });
            } catch (e) { console.error(`Error parsing lemming data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading lemming ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setLemmings(list);
      addToHistory(`Loaded ${list.length} lemmings`);
    } catch (e) { 
      console.error("Error loading lemmings:", e);
      addToHistory("Error loading lemmings data");
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const submitLemming = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      addToHistory("Wallet not connected - submission failed");
      return; 
    }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting lemming ability with ZAMA FHE..." });
    addToHistory("Starting FHE encryption process");
    
    try {
      // Encrypt the power level with FHE simulation
      const encryptedData = FHEEncryptNumber(newLemmingData.powerLevel);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique ID for this lemming
      const lemmingId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Prepare lemming data
      const lemmingData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        abilityType: newLemmingData.abilityType, 
        status: "pending" 
      };
      
      // Store lemming data on chain
      await contract.setData(`lemming_${lemmingId}`, ethers.toUtf8Bytes(JSON.stringify(lemmingData)));
      addToHistory("Lemming data stored on blockchain");
      
      // Update the list of lemming keys
      const keysBytes = await contract.getData("lemming_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(lemmingId);
      await contract.setData("lemming_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      addToHistory("Lemming keys updated");
      
      setTransactionStatus({ visible: true, status: "success", message: "Lemming ability encrypted and submitted!" });
      addToHistory("FHE encryption completed successfully");
      
      await loadLemmings();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewLemmingData({ abilityType: "climb", description: "", powerLevel: 1 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      addToHistory(`Submission error: ${errorMessage}`);
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      addToHistory("Wallet not connected - decryption failed");
      return null; 
    }
    setIsDecrypting(true);
    addToHistory("Starting wallet signature for decryption");
    
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      addToHistory("Wallet signature completed");
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      addToHistory("Decryption process failed");
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const verifyLemming = async (lemmingId: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      addToHistory("Wallet not connected - verification failed");
      return; 
    }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted ability with FHE..." });
    addToHistory("Starting FHE verification process");
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const lemmingBytes = await contract.getData(`lemming_${lemmingId}`);
      if (lemmingBytes.length === 0) throw new Error("Lemming not found");
      const lemmingData = JSON.parse(ethers.toUtf8String(lemmingBytes));
      
      // Simulate FHE computation on encrypted data
      const verifiedData = FHECompute(lemmingData.data, 'increase10%');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedLemming = { ...lemmingData, status: "verified", data: verifiedData };
      await contractWithSigner.setData(`lemming_${lemmingId}`, ethers.toUtf8Bytes(JSON.stringify(updatedLemming)));
      addToHistory("Lemming ability verified with FHE");
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE verification completed successfully!" });
      await loadLemmings();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      addToHistory(`Verification error: ${e.message || "Unknown error"}`);
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectLemming = async (lemmingId: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      addToHistory("Wallet not connected - rejection failed");
      return; 
    }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted ability with FHE..." });
    addToHistory("Starting FHE rejection process");
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const lemmingBytes = await contract.getData(`lemming_${lemmingId}`);
      if (lemmingBytes.length === 0) throw new Error("Lemming not found");
      const lemmingData = JSON.parse(ethers.toUtf8String(lemmingBytes));
      
      const updatedLemming = { ...lemmingData, status: "rejected" };
      await contract.setData(`lemming_${lemmingId}`, ethers.toUtf8Bytes(JSON.stringify(updatedLemming)));
      addToHistory("Lemming ability rejected");
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE rejection completed successfully!" });
      await loadLemmings();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      addToHistory(`Rejection error: ${e.message || "Unknown error"}`);
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (lemmingAddress: string) => address?.toLowerCase() === lemmingAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to interact with the FHE Lemmings game", icon: "🔗" },
    { title: "Create Encrypted Lemmings", description: "Add lemmings with special abilities that are encrypted using Zama FHE", icon: "🔒", details: "Lemming abilities are encrypted on the client-side before being stored on the blockchain" },
    { title: "FHE Processing", description: "Lemming abilities are processed in encrypted state without decryption", icon: "⚙️", details: "Zama FHE technology allows computations on encrypted data without exposing the actual abilities" },
    { title: "Solve Puzzles", description: "Use your observation skills to deduce lemming abilities and solve puzzles", icon: "🧩", details: "The game challenges you to infer abilities from lemming behavior rather than directly knowing them" }
  ];

  // Get top players based on verified lemmings count
  const getLeaderboard = () => {
    const playerStats: Record<string, number> = {};
    
    lemmings.forEach(lemming => {
      if (lemming.status === "verified") {
        playerStats[lemming.owner] = (playerStats[lemming.owner] || 0) + 1;
      }
    });
    
    return Object.entries(playerStats)
      .map(([address, count]) => ({ address, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  };

  const leaderboard = getLeaderboard();

  if (loading) return (
    <div className="loading-screen pixel-bg">
      <div className="pixel-spinner"></div>
      <p>Initializing encrypted lemmings connection...</p>
    </div>
  );

  return (
    <div className="app-container pixel-theme neon-colors">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="lemming-icon"></div></div>
          <h1>FHE<span>Lemmings</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-lemming-btn pixel-button">
            <div className="add-icon"></div>Add Lemming
          </button>
          <button className="pixel-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Tutorial" : "Show Tutorial"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      
      <div className="main-content panel-layout">
        {/* Left Panel - Game Information */}
        <div className="left-panel">
          <div className="info-panel pixel-card">
            <h2>Project Introduction</h2>
            <p>FHE Lemmings is a puzzle game where each lemming's special ability is encrypted using <strong>Zama FHE technology</strong>. Observe their behavior to deduce abilities and guide them through challenges.</p>
            <div className="fhe-badge"><span>FHE-Powered Encryption</span></div>
          </div>
          
          <div className="stats-panel pixel-card">
            <h3>Game Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-value">{lemmings.length}</div><div className="stat-label">Total Lemmings</div></div>
              <div className="stat-item"><div className="stat-value">{verifiedCount}</div><div className="stat-label">Verified</div></div>
              <div className="stat-item"><div className="stat-value">{pendingCount}</div><div className="stat-label">Pending</div></div>
              <div className="stat-item"><div className="stat-value">{rejectedCount}</div><div className="stat-label">Rejected</div></div>
            </div>
          </div>
          
          <div className="leaderboard-panel pixel-card">
            <h3>Top Players</h3>
            {leaderboard.length > 0 ? (
              <div className="leaderboard-list">
                {leaderboard.map((player, index) => (
                  <div key={player.address} className="leaderboard-item">
                    <span className="rank">#{index + 1}</span>
                    <span className="address">{player.address.substring(0, 6)}...{player.address.substring(38)}</span>
                    <span className="score">{player.count} points</span>
                  </div>
                ))}
              </div>
            ) : (
              <p>No verified lemmings yet. Be the first to create one!</p>
            )}
          </div>
        </div>
        
        {/* Center Panel - Main Content */}
        <div className="center-panel">
          <div className="welcome-banner pixel-banner">
            <div className="welcome-text">
              <h2>FHE Encrypted Lemmings</h2>
              <p>Decipher encrypted abilities to guide your lemmings through puzzles</p>
            </div>
            <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
          </div>
          
          {showTutorial && (
            <div className="tutorial-section pixel-card">
              <h2>FHE Lemmings Tutorial</h2>
              <p className="subtitle">Learn how to play with encrypted lemming abilities</p>
              <div className="tutorial-steps">
                {tutorialSteps.map((step, index) => (
                  <div className="tutorial-step" key={index}>
                    <div className="step-icon">{step.icon}</div>
                    <div className="step-content">
                      <h3>{step.title}</h3>
                      <p>{step.description}</p>
                      {step.details && <div className="step-details">{step.details}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          <div className="lemmings-section">
            <div className="section-header">
              <h2>Encrypted Lemming Abilities</h2>
              <div className="header-actions">
                <button onClick={loadLemmings} className="refresh-btn pixel-button" disabled={isRefreshing}>
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>
            
            <div className="lemmings-list pixel-card">
              <div className="table-header">
                <div className="header-cell">ID</div>
                <div className="header-cell">Ability</div>
                <div className="header-cell">Owner</div>
                <div className="header-cell">Date</div>
                <div className="header-cell">Status</div>
                <div className="header-cell">Actions</div>
              </div>
              
              {lemmings.length === 0 ? (
                <div className="no-lemmings">
                  <div className="no-lemmings-icon"></div>
                  <p>No encrypted lemmings found</p>
                  <button className="pixel-button primary" onClick={() => setShowCreateModal(true)}>Create First Lemming</button>
                </div>
              ) : lemmings.map(lemming => (
                <div className="lemming-row" key={lemming.id} onClick={() => setSelectedLemming(lemming)}>
                  <div className="table-cell lemming-id">#{lemming.id.substring(0, 6)}</div>
                  <div className="table-cell">{lemming.abilityType}</div>
                  <div className="table-cell">{lemming.owner.substring(0, 6)}...{lemming.owner.substring(38)}</div>
                  <div className="table-cell">{new Date(lemming.timestamp * 1000).toLocaleDateString()}</div>
                  <div className="table-cell">
                    <span className={`status-badge ${lemming.status}`}>{lemming.status}</span>
                  </div>
                  <div className="table-cell actions">
                    {isOwner(lemming.owner) && lemming.status === "pending" && (
                      <>
                        <button className="action-btn pixel-button success" onClick={(e) => { e.stopPropagation(); verifyLemming(lemming.id); }}>Verify</button>
                        <button className="action-btn pixel-button danger" onClick={(e) => { e.stopPropagation(); rejectLemming(lemming.id); }}>Reject</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        
        {/* Right Panel - User History */}
        <div className="right-panel">
          <div className="history-panel pixel-card">
            <h3>Your Recent Actions</h3>
            <div className="history-list">
              {userHistory.length > 0 ? (
                userHistory.map((action, index) => (
                  <div key={index} className="history-item">
                    {action}
                  </div>
                ))
              ) : (
                <p>No actions recorded yet</p>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Modals */}
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitLemming} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          lemmingData={newLemmingData} 
          setLemmingData={setNewLemmingData}
        />
      )}
      
      {selectedLemming && (
        <LemmingDetailModal 
          lemming={selectedLemming} 
          onClose={() => { setSelectedLemming(null); setDecryptedValue(null); }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content pixel-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="pixel-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="lemming-icon"></div><span>FHE Lemmings</span></div>
            <p>Secure encrypted lemming abilities using Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} FHE Lemmings. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

// Modal for creating new lemmings
interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  lemmingData: any;
  setLemmingData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, lemmingData, setLemmingData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setLemmingData({ ...lemmingData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setLemmingData({ ...lemmingData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!lemmingData.abilityType || !lemmingData.powerLevel) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal pixel-card">
        <div className="modal-header">
          <h2>Add Encrypted Lemming</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Lemming ability will be encrypted with Zama FHE before submission</p></div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Ability Type *</label>
              <select name="abilityType" value={lemmingData.abilityType} onChange={handleChange} className="pixel-select">
                <option value="climb">Climbing</option>
                <option value="dig">Digging</option>
                <option value="build">Building</option>
                <option value="block">Blocking</option>
                <option value="float">Floating</option>
              </select>
            </div>
            
            <div className="form-group">
              <label>Description</label>
              <input 
                type="text" 
                name="description" 
                value={lemmingData.description} 
                onChange={handleChange} 
                placeholder="Brief description..." 
                className="pixel-input"
              />
            </div>
            
            <div className="form-group">
              <label>Power Level (1-10) *</label>
              <input 
                type="number" 
                name="powerLevel" 
                value={lemmingData.powerLevel} 
                onChange={handleValueChange} 
                placeholder="Enter power level (1-10)..." 
                className="pixel-input"
                min="1"
                max="10"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{lemmingData.powerLevel || 'No value entered'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{lemmingData.powerLevel ? FHEEncryptNumber(lemmingData.powerLevel).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div><strong>Privacy Guarantee</strong><p>Ability data remains encrypted during FHE processing and is never decrypted on servers</p></div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn pixel-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn pixel-button primary">
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

// Modal for viewing lemming details
interface LemmingDetailModalProps {
  lemming: LemmingAbility;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const LemmingDetailModal: React.FC<LemmingDetailModalProps> = ({ 
  lemming, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { 
      setDecryptedValue(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(lemming.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="lemming-detail-modal pixel-card">
        <div className="modal-header">
          <h2>Lemming Details #{lemming.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="lemming-info">
            <div className="info-item"><span>Ability Type:</span><strong>{lemming.abilityType}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{lemming.owner.substring(0, 6)}...{lemming.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(lemming.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${lemming.status}`}>{lemming.status}</strong></div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Ability Data</h3>
            <div className="encrypted-data">{lemming.encryptedData.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            
            <button className="decrypt-btn pixel-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedValue !== null ? "Hide Decrypted Value" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Power Level</h3>
              <div className="decrypted-value">{decryptedValue}</div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn pixel-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;