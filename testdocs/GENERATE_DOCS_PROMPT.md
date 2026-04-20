# Generating Test Document Images

Use this prompt with any image-generating LLM (ChatGPT, Gemini, etc.) to create realistic-looking maritime document scans for testing.

## Prompt

Copy and paste the following prompt. Generate each document separately.

---

```
Generate a realistic-looking scanned image of a maritime seafarer document. Make it look like a real government/authority-issued certificate that has been scanned or photographed — slightly imperfect, with stamps, signatures, and official formatting.

Use the following details for ALL documents (same seafarer):

Seafarer Identity:
- Full Name: JUAN CARLOS DELA CRUZ
- Date of Birth: 15/03/1988
- Nationality: Filipino
- Passport Number: P4821553
- SIRB Number: SIRB-2024-00847
- Rank: Second Officer (Deck)

Generate this specific document:

[PASTE ONE OF THE DOCUMENTS BELOW]
```

---

## Documents to Generate (one image per prompt)

### 1. Certificate of Competency (COC)
```
Document: Certificate of Competency (COC)
Issuing Authority: MARINA (Maritime Industry Authority), Republic of the Philippines
Certificate Number: COC-2023-DK-004821
Rank/Capacity: Officer in Charge of a Navigational Watch (OICNW)
STCW Regulation: STCW Reg II/1
Date of Issue: 10/01/2023
Date of Expiry: 10/01/2028
Limitations: None
Include: Official MARINA seal, hologram placeholder, registrar signature
```

### 2. SIRB (Seafarer's Identification and Record Book)
```
Document: Seafarer's Identification and Record Book (SIRB)
SIRB Number: SIRB-2024-00847
Issuing Authority: MARINA, Republic of the Philippines
Date of Issue: 05/06/2024
Date of Expiry: 05/06/2029
Include: Photo placeholder (headshot area), thumbprint box, sea service record pages showing:
  - MV Pacific Voyager (Bulk Carrier, Flag: Panama) — 2nd Officer — 12/2023 to 06/2024
  - MV Orient Star (Container, Flag: Liberia) — 3rd Officer — 03/2022 to 11/2023
```

### 3. Passport
```
Document: Philippine Passport
Passport Number: P4821553
Surname: DELA CRUZ
Given Names: JUAN CARLOS
Nationality: Filipino
Date of Birth: 15/03/1988
Place of Birth: Manila, Philippines
Date of Issue: 22/08/2022
Date of Expiry: 22/08/2032
Sex: Male
Include: Machine-readable zone (MRZ) at the bottom, photo placeholder, DFA logo
```

### 4. PEME (Pre-Employment Medical Examination)
```
Document: Pre-Employment Medical Examination (PEME) Certificate
Clinic: St. Luke's Maritime Medical Center
Clinic Address: Manila, Philippines
Certificate Number: PEME-2026-18472
Seafarer Name: JUAN CARLOS DELA CRUZ
Fitness Result: FIT FOR SEA DUTY
Date of Examination: 01/02/2026
Date of Expiry: 01/02/2028
Blood Type: O+
Visual Acuity: 20/20
Color Vision: Normal (Ishihara)
BMI: 24.3
Restrictions: None
Include: Doctor signature, clinic stamp, "FIT" stamped in green
```

### 5. Drug and Alcohol Test Certificate
```
Document: Drug and Alcohol Test Certificate
Laboratory: Philippine Drug Testing Center
Certificate Number: DRUG-2026-55210
Seafarer Name: JUAN CARLOS DELA CRUZ
Date of Test: 01/02/2026
Specimens: Urine, Blood
Results:
  - Methamphetamine: NEGATIVE
  - THC: NEGATIVE
  - Cocaine: NEGATIVE
  - Opiates: NEGATIVE
  - Alcohol: NEGATIVE (BAC 0.00%)
Overall Result: NEGATIVE
Validity: 6 months from test date
Include: Lab director signature, accreditation number, "NEGATIVE" stamp
```

### 6. Basic Training (COP_BT) — STCW A-VI/1
```
Document: Certificate of Proficiency — Basic Safety Training
Training Provider: MAAP (Maritime Academy of Asia and the Pacific)
Certificate Number: BT-2022-08441
STCW Reference: STCW Reg VI/1, Table A-VI/1
IMO Model Course: 1.19, 1.20, 1.21, 1.23
Modules: Personal Survival Techniques, Fire Prevention & Fighting, Elementary First Aid, Personal Safety & Social Responsibilities
Date of Issue: 15/03/2022
Date of Expiry: 15/03/2027
Include: MAAP seal, MARINA authentication stamp, training director signature
```

### 7. Proficiency in Survival Craft and Rescue Boats (COP_PSCRB)
```
Document: Certificate of Proficiency — Survival Craft and Rescue Boats
Training Provider: MAAP
Certificate Number: PSCRB-2022-03291
STCW Reference: STCW Reg VI/2, Table A-VI/2-1
IMO Model Course: 1.23
Date of Issue: 20/03/2022
Date of Expiry: 20/03/2027
Include: MAAP seal, MARINA authentication stamp
```

### 8. Advanced Fire Fighting (COP_AFF)
```
Document: Certificate of Proficiency — Advanced Fire Fighting
Training Provider: MAAP
Certificate Number: AFF-2022-01187
STCW Reference: STCW Reg VI/3
IMO Model Course: 2.03
Date of Issue: 28/03/2022
Date of Expiry: 28/03/2027
Include: MAAP seal, MARINA authentication stamp
```

### 9. Medical First Aid (COP_MEFA)
```
Document: Certificate of Proficiency — Medical First Aid
Training Provider: MAAP
Certificate Number: MEFA-2022-07723
STCW Reference: STCW Reg VI/4, Section A-VI/4-1
IMO Model Course: 1.14
Date of Issue: 02/04/2022
Date of Expiry: 02/04/2027
Include: MAAP seal, MARINA authentication stamp
```

### 10. ECDIS Generic Training
```
Document: ECDIS Training Certificate (Generic)
Training Provider: Jeppesen Philippines Maritime Training Center
Certificate Number: ECDIS-2023-G-00612
STCW Reference: STCW Table A-II/1 (Function: Navigation at the Operational Level)
IMO Model Course: 1.27
Date of Issue: 05/11/2023
Date of Expiry: 05/11/2028
Include: Training center logo, MARINA validation stamp
```

### 11. BRM/SSBT (Bridge Resource Management & Ship Handling)
```
Document: Bridge Resource Management & Ship Simulator and Bridge Teamwork Training
Training Provider: MAAP
Certificate Number: BRM-2023-02198
STCW Reference: STCW Reg II/1, Table A-II/1
IMO Model Course: 1.22
Date of Issue: 12/12/2023
Date of Expiry: 12/12/2028
Include: MAAP seal, MARINA authentication stamp
```

### 12. Flag State Endorsement
```
Document: Flag State Endorsement / Recognition of Certificate
Flag State: Republic of Panama (Panama Maritime Authority — AMP)
Endorsement Number: PAN-FSE-2024-118847
Endorsing: COC issued by MARINA, Philippines (COC-2023-DK-004821)
Seafarer Name: JUAN CARLOS DELA CRUZ
Rank Endorsed: Officer in Charge of a Navigational Watch
STCW Regulation: Reg II/1
Date of Issue: 15/02/2024
Date of Expiry: 15/02/2029
Include: Panama Maritime Authority seal, consul signature, STCW reference
```

---

## Tips
- Save each generated image as a JPEG or PNG
- Name files descriptively: `coc.jpg`, `sirb.jpg`, `passport.jpg`, `peme.jpg`, `drug_test.jpg`, `cop_bt.jpg`, `cop_pscrb.jpg`, `cop_aff.jpg`, `cop_mefa.jpg`, `ecdis.jpg`, `brm_ssbt.jpg`, `flag_state.jpg`
- Place all files in the `testdocs/` directory
- All documents use the same seafarer identity for consistency across session validation
